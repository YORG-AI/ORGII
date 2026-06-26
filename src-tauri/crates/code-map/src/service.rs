use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::db::CodeMapDb;
use crate::format::{explore_text, node_text, related_text, search_text, status_text};
use crate::indexer::{collect_supported_files, index_workspace, scan_freshness};
use crate::paths::{canonical_workspace, relative_path};
use crate::types::{
    CodeMapAction, CodeMapIndexPhase, CodeMapIndexProgress, CodeMapNode, CodeMapNodeDetails,
    CodeMapQueryRequest, CodeMapSearchResponse, CodeMapSourceWindow, CodeMapStatus,
    CodeMapStatusKind, CodeMapWorkspaceSummary,
};
use crate::{CodeMapError, Result};

const MAX_RESULTS_CAP: usize = 200;
const MAX_DEPTH_CAP: usize = 5;
const SOURCE_CONTEXT_LINES: u32 = 4;

static ACTIVE_INDEXES: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PROGRESS: Lazy<Mutex<HashMap<String, CodeMapIndexProgress>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct ActiveIndexGuard {
    key: String,
}

impl ActiveIndexGuard {
    fn new(key: String) -> Self {
        Self { key }
    }
}

impl Drop for ActiveIndexGuard {
    fn drop(&mut self) {
        ACTIVE_INDEXES.lock().remove(&self.key);
        PROGRESS.lock().remove(&self.key);
    }
}

pub struct CodeMapService;

impl CodeMapService {
    pub async fn status(workspace_path: PathBuf) -> Result<CodeMapStatus> {
        get_status(workspace_path).await
    }

    pub async fn query(action: CodeMapAction, request: CodeMapQueryRequest) -> Result<String> {
        let workspace_path = request.workspace_path.clone();
        tokio::task::spawn_blocking(move || query_blocking(action, request, workspace_path))
            .await
            .map_err(|err| CodeMapError::Join(err.to_string()))?
    }
}

pub async fn get_status(workspace_path: PathBuf) -> Result<CodeMapStatus> {
    let canonical = canonical_workspace(&workspace_path)?;
    let key = canonical.to_string_lossy().to_string();
    let progress = PROGRESS.lock().get(&key).cloned();
    let has_active_index = ACTIVE_INDEXES.lock().contains_key(&key);
    tokio::task::spawn_blocking(move || {
        let mut db = CodeMapDb::open(&canonical)?;
        refresh_staleness(&mut db, &canonical)?;
        let mut status = db.status()?;
        if let Some(progress) = progress.filter(|_| has_active_index) {
            status.status = CodeMapStatusKind::Indexing;
            status.progress = Some(progress);
        } else if matches!(status.status, CodeMapStatusKind::Indexing) {
            db.set_status(
                CodeMapStatusKind::Failed,
                Some("Indexing stopped before completion"),
            )?;
            status = db.status()?;
        }
        Ok(status)
    })
    .await
    .map_err(|err| CodeMapError::Join(err.to_string()))?
}

pub async fn get_many_statuses(
    workspace_paths: Vec<PathBuf>,
) -> Result<Vec<CodeMapWorkspaceSummary>> {
    let mut summaries = Vec::new();
    for workspace_path in workspace_paths {
        let status = get_status(workspace_path).await?;
        summaries.push(CodeMapWorkspaceSummary {
            workspace_path: status.workspace_path,
            status: status.status,
            files: status.files,
            symbols: status.symbols,
            relationships: status.relationships,
            unresolved: status.unresolved,
            stale_files: status.stale_files,
            index_size_bytes: status.index_size_bytes,
            freshness: status.freshness,
            last_indexed_at: status.last_indexed_at,
            error: status.error,
        });
    }
    Ok(summaries)
}

pub async fn start_index(
    app: Option<AppHandle>,
    workspace_path: PathBuf,
    force: bool,
) -> Result<CodeMapStatus> {
    let canonical = canonical_workspace(&workspace_path)?;
    let key = canonical.to_string_lossy().to_string();
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE_INDEXES.lock();
        if active.contains_key(&key) {
            return Err(CodeMapError::AlreadyIndexing(key));
        }
        active.insert(key.clone(), cancellation.clone());
    }
    let _active_index_guard = ActiveIndexGuard::new(key.clone());

    set_progress(
        &key,
        CodeMapIndexProgress {
            workspace_path: key.clone(),
            phase: CodeMapIndexPhase::Queued,
            files_processed: 0,
            files_total: 0,
            current_file: None,
            added_files: 0,
            modified_files: 0,
            deleted_files: 0,
            error: None,
        },
        app.as_ref(),
    );

    let result = tokio::task::spawn_blocking({
        let key = key.clone();
        let app = app.clone();
        move || {
            let mut db = CodeMapDb::open(&canonical)?;
            let requires_full_rebuild = force || db.requires_full_rebuild()?;
            let stored = if requires_full_rebuild {
                HashMap::new()
            } else {
                db.stored_file_hashes()?
            };

            set_progress(
                &key,
                CodeMapIndexProgress {
                    workspace_path: key.clone(),
                    phase: CodeMapIndexPhase::Scanning,
                    files_processed: 0,
                    files_total: 0,
                    current_file: None,
                    added_files: 0,
                    modified_files: 0,
                    deleted_files: 0,
                    error: None,
                },
                app.as_ref(),
            );

            let scan = scan_freshness(&canonical, &stored, requires_full_rebuild);
            if !force && scan.is_fresh() && db.status()?.files > 0 {
                let status = db.status()?;
                emit_status_changed(app.as_ref(), &status);
                return Ok(status);
            }

            db.set_status(CodeMapStatusKind::Indexing, None)?;
            emit_status_changed(app.as_ref(), &db.status()?);

            let files_to_index = if requires_full_rebuild {
                collect_supported_files(&canonical)
            } else {
                scan.added
                    .iter()
                    .chain(scan.modified.iter())
                    .cloned()
                    .collect()
            };
            let deleted_files = if requires_full_rebuild {
                db.stored_file_paths()?
            } else {
                scan.deleted.clone()
            };

            let indexed = index_workspace(
                canonical.clone(),
                files_to_index,
                deleted_files,
                scan.added.len() as u32,
                scan.modified.len() as u32,
                cancellation.clone(),
                |progress| {
                    set_progress(&key, progress, app.as_ref());
                },
            );

            match indexed {
                Ok(result) => {
                    let added_files = result.added_files;
                    let modified_files = result.modified_files;
                    let deleted_files_count = result.deleted_files.len() as u32;
                    if cancellation.load(Ordering::Relaxed) {
                        return set_cancelled_status(
                            &db,
                            &key,
                            app.as_ref(),
                            added_files,
                            modified_files,
                            deleted_files_count,
                        );
                    }
                    if let Err(err) = db.apply_index_changes_with_cancellation(
                        result.extracted_files,
                        &result.deleted_files,
                        Some(&cancellation),
                    ) {
                        if matches!(err, CodeMapError::Cancelled(_)) {
                            return set_cancelled_status(
                                &db,
                                &key,
                                app.as_ref(),
                                added_files,
                                modified_files,
                                deleted_files_count,
                            );
                        }
                        return set_failed_status(
                            &db,
                            &key,
                            app.as_ref(),
                            err,
                            added_files,
                            modified_files,
                            deleted_files_count,
                        );
                    }
                    let status = db.status()?;
                    set_progress(
                        &key,
                        CodeMapIndexProgress {
                            workspace_path: key.clone(),
                            phase: CodeMapIndexPhase::Complete,
                            files_processed: status.files,
                            files_total: status.files,
                            current_file: None,
                            added_files,
                            modified_files,
                            deleted_files: deleted_files_count,
                            error: None,
                        },
                        app.as_ref(),
                    );
                    emit_status_changed(app.as_ref(), &status);
                    Ok(status)
                }
                Err(CodeMapError::Cancelled(_)) => {
                    set_cancelled_status(&db, &key, app.as_ref(), 0, 0, 0)
                }
                Err(err) => set_failed_status(&db, &key, app.as_ref(), err, 0, 0, 0),
            }
        }
    })
    .await
    .map_err(|err| CodeMapError::Join(err.to_string()))?;

    result
}

pub async fn cancel_index(workspace_path: PathBuf) -> Result<bool> {
    let canonical = canonical_workspace(&workspace_path)?;
    let key = canonical.to_string_lossy().to_string();
    if let Some(flag) = ACTIVE_INDEXES.lock().get(&key).cloned() {
        flag.store(true, Ordering::Relaxed);
        return Ok(true);
    }
    PROGRESS.lock().remove(&key);
    tokio::task::spawn_blocking(move || {
        let db = CodeMapDb::open(&canonical)?;
        let status = db.status()?;
        if matches!(status.status, CodeMapStatusKind::Indexing) {
            db.set_status(CodeMapStatusKind::Cancelled, None)?;
            return Ok(true);
        }
        Ok(false)
    })
    .await
    .map_err(|err| CodeMapError::Join(err.to_string()))?
}

pub async fn clear_index(workspace_path: PathBuf) -> Result<CodeMapStatus> {
    let canonical = canonical_workspace(&workspace_path)?;
    tokio::task::spawn_blocking(move || {
        CodeMapDb::delete_for_workspace(&canonical)?;
        CodeMapDb::open(&canonical)?.status()
    })
    .await
    .map_err(|err| CodeMapError::Join(err.to_string()))?
}

pub async fn search(
    workspace_path: PathBuf,
    request: CodeMapQueryRequest,
) -> Result<CodeMapSearchResponse> {
    tokio::task::spawn_blocking(move || search_blocking(workspace_path, request))
        .await
        .map_err(|err| CodeMapError::Join(err.to_string()))?
}

pub async fn node_details(
    workspace_path: PathBuf,
    request: CodeMapQueryRequest,
) -> Result<CodeMapNodeDetails> {
    tokio::task::spawn_blocking(move || node_details_blocking(workspace_path, request))
        .await
        .map_err(|err| CodeMapError::Join(err.to_string()))?
}

fn refresh_staleness(db: &mut CodeMapDb, workspace_root: &Path) -> Result<()> {
    let stored = db.stored_file_hashes()?;
    if stored.is_empty() {
        return Ok(());
    }
    let scan = scan_freshness(workspace_root, &stored, db.requires_full_rebuild()?);
    let stale_files = scan
        .modified
        .iter()
        .map(|path| relative_path(workspace_root, path))
        .chain(scan.deleted)
        .collect::<Vec<_>>();
    db.mark_stale_files(&stale_files)
}

fn query_blocking(
    action: CodeMapAction,
    request: CodeMapQueryRequest,
    workspace_path: PathBuf,
) -> Result<String> {
    let canonical = canonical_workspace(&workspace_path)?;
    let max_results = request.max_results.clamp(1, MAX_RESULTS_CAP);
    match action {
        CodeMapAction::Status => {
            let mut db = CodeMapDb::open(&canonical)?;
            refresh_staleness(&mut db, &canonical)?;
            Ok(status_text(&db.status()?))
        }
        CodeMapAction::Search => {
            let response = search_blocking(canonical, request)?;
            Ok(search_text(&response))
        }
        CodeMapAction::Explore => {
            let response = search_blocking(canonical, request)?;
            Ok(explore_text(&response))
        }
        CodeMapAction::Node => {
            let details = node_details_blocking(canonical, request)?;
            Ok(node_text(&details))
        }
        CodeMapAction::Callers => {
            let db = CodeMapDb::open(&canonical)?;
            let node = resolve_node(&db, &canonical, &request)?;
            let nodes = db
                .edges_for_node(&node.id, true, max_results, true)?
                .into_iter()
                .map(|relationship| relationship.node)
                .collect::<Vec<_>>();
            Ok(related_text("callers/references", &nodes))
        }
        CodeMapAction::Callees => {
            let db = CodeMapDb::open(&canonical)?;
            let node = resolve_node(&db, &canonical, &request)?;
            let nodes = db
                .edges_for_node(&node.id, false, max_results, true)?
                .into_iter()
                .map(|relationship| relationship.node)
                .collect::<Vec<_>>();
            Ok(related_text("callees/references", &nodes))
        }
        CodeMapAction::Impact => {
            let db = CodeMapDb::open(&canonical)?;
            let node = resolve_node(&db, &canonical, &request)?;
            let nodes = db.impact(
                &node.id,
                request.max_depth.clamp(1, MAX_DEPTH_CAP),
                max_results,
            )?;
            Ok(related_text("impact", &nodes))
        }
    }
}

fn search_blocking(
    workspace_path: PathBuf,
    request: CodeMapQueryRequest,
) -> Result<CodeMapSearchResponse> {
    let canonical = canonical_workspace(&workspace_path)?;
    let mut db = CodeMapDb::open(&canonical)?;
    refresh_staleness(&mut db, &canonical)?;
    let query = request
        .query
        .clone()
        .ok_or_else(|| CodeMapError::InvalidRequest("query is required".to_string()))?;
    let max_results = request.max_results.clamp(1, MAX_RESULTS_CAP);
    let mut results = db.search_nodes(
        &query,
        max_results + 1,
        request.kind,
        request.language,
        request.path_prefix.as_deref(),
    )?;
    let truncated = results.len() > max_results;
    results.truncate(max_results);
    if request.include_source {
        for result in &mut results {
            result.source = source_window(&canonical, &result.node, SOURCE_CONTEXT_LINES);
        }
    }
    let status = db.status()?;
    Ok(CodeMapSearchResponse {
        workspace_path: status.workspace_path,
        query,
        results,
        unresolved_count: status.unresolved,
        stale_files: status.stale_files,
        truncated,
    })
}

fn node_details_blocking(
    workspace_path: PathBuf,
    request: CodeMapQueryRequest,
) -> Result<CodeMapNodeDetails> {
    let canonical = canonical_workspace(&workspace_path)?;
    let db = CodeMapDb::open(&canonical)?;
    let node = resolve_node(&db, &canonical, &request)?;
    let incoming = if request.include_relationships {
        db.edges_for_node(&node.id, true, 50, false)?
    } else {
        Vec::new()
    };
    let outgoing = if request.include_relationships {
        db.edges_for_node(&node.id, false, 50, false)?
    } else {
        Vec::new()
    };
    let source = if request.include_source {
        source_window(&canonical, &node, SOURCE_CONTEXT_LINES)
    } else {
        None
    };
    Ok(CodeMapNodeDetails {
        node,
        incoming,
        outgoing,
        source,
    })
}

fn resolve_node(
    db: &CodeMapDb,
    workspace_root: &Path,
    request: &CodeMapQueryRequest,
) -> Result<CodeMapNode> {
    if let Some(node_id) = &request.node_id {
        return db
            .node_by_id(node_id)?
            .ok_or_else(|| CodeMapError::NodeNotFound(node_id.clone()));
    }
    if let Some(file_path) = &request.file_path {
        let relative = if file_path.is_absolute() {
            relative_path(workspace_root, file_path)
        } else {
            file_path.to_string_lossy().replace('\\', "/")
        };
        let mut nodes = db.node_by_file_path(&relative, 1)?;
        if let Some(node) = nodes.pop() {
            return Ok(node);
        }
        return Err(CodeMapError::NodeNotFound(relative));
    }
    if let Some(query) = &request.query {
        let mut nodes = db.search_nodes(
            query,
            1,
            request.kind,
            request.language,
            request.path_prefix.as_deref(),
        )?;
        if let Some(result) = nodes.pop() {
            return Ok(result.node);
        }
        return Err(CodeMapError::NodeNotFound(query.clone()));
    }
    Err(CodeMapError::InvalidRequest(
        "node_id, file_path, or query is required".to_string(),
    ))
}

fn source_window(
    workspace_root: &Path,
    node: &CodeMapNode,
    context: u32,
) -> Option<CodeMapSourceWindow> {
    let path = workspace_root.join(&node.file_path);
    let Ok(content) = std::fs::read_to_string(path) else {
        return None;
    };
    let start = node.start_line.saturating_sub(context).max(1);
    let end = node.end_line.saturating_add(context);
    let mut text = String::new();
    for (index, line) in content.lines().enumerate() {
        let line_number = index as u32 + 1;
        if line_number >= start && line_number <= end {
            text.push_str(&format!("{:>5}|{}\n", line_number, line));
        }
    }
    Some(CodeMapSourceWindow {
        file_path: node.file_path.clone(),
        start_line: start,
        end_line: end,
        text,
    })
}

fn set_cancelled_status(
    db: &CodeMapDb,
    key: &str,
    app: Option<&AppHandle>,
    added_files: u32,
    modified_files: u32,
    deleted_files: u32,
) -> Result<CodeMapStatus> {
    db.set_status(CodeMapStatusKind::Cancelled, None)?;
    let status = db.status()?;
    set_progress(
        key,
        CodeMapIndexProgress {
            workspace_path: key.to_string(),
            phase: CodeMapIndexPhase::Cancelled,
            files_processed: 0,
            files_total: 0,
            current_file: None,
            added_files,
            modified_files,
            deleted_files,
            error: None,
        },
        app,
    );
    emit_status_changed(app, &status);
    Ok(status)
}

fn set_failed_status(
    db: &CodeMapDb,
    key: &str,
    app: Option<&AppHandle>,
    err: CodeMapError,
    added_files: u32,
    modified_files: u32,
    deleted_files: u32,
) -> Result<CodeMapStatus> {
    let error = err.to_string();
    db.set_status(CodeMapStatusKind::Failed, Some(&error))?;
    let status = db.status()?;
    set_progress(
        key,
        CodeMapIndexProgress {
            workspace_path: key.to_string(),
            phase: CodeMapIndexPhase::Failed,
            files_processed: 0,
            files_total: 0,
            current_file: None,
            added_files,
            modified_files,
            deleted_files,
            error: Some(error),
        },
        app,
    );
    emit_status_changed(app, &status);
    Ok(status)
}

fn set_progress(key: &str, progress: CodeMapIndexProgress, app: Option<&AppHandle>) {
    PROGRESS.lock().insert(key.to_string(), progress.clone());
    if let Some(app) = app {
        let _ = app.emit("code-map:index-progress", progress);
    }
}

fn emit_status_changed(app: Option<&AppHandle>, status: &CodeMapStatus) {
    if let Some(app) = app {
        let _ = app.emit("code-map:status-changed", status);
    }
}
