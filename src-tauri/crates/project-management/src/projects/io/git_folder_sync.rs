//! Git folder file sync for native project orgs.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::helpers::from_iso8601;
use super::{
    read_all_projects_scoped, read_all_work_items_scoped, read_project_org, read_project_scoped,
    read_work_item_scoped, write_project, write_work_item,
};
use crate::projects::types::{
    ProjectGitFolderConflictEntityType, ProjectGitFolderConflictKind, ProjectGitFolderSyncConflict,
    ProjectGitFolderSyncStatus, ProjectOrg, ResolveProjectOrgGitFolderConflictRequest,
    SyncProjectOrgGitFolderRequest, SyncProjectOrgGitFolderResult, WorkItemData,
    WorkItemFrontmatter,
};

const GIT_FOLDER_SYNC_PROVIDER: &str = "git_folder";
const ORGII_DIR: &str = ".orgii";
const ORG_FILE: &str = "org.json";
const PROJECTS_DIR: &str = "projects";
const PROJECT_FILE: &str = "project.json";
const WORK_ITEMS_DIR: &str = "work-items";
const MARKDOWN_EXTENSION: &str = "md";

#[derive(Debug, Deserialize)]
struct GitFolderSyncConfig {
    folder_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectFileRecord {
    slug: String,
    meta: crate::projects::types::ProjectMeta,
    description: String,
}

pub fn sync_project_org_git_folder(
    request: &SyncProjectOrgGitFolderRequest,
) -> Result<SyncProjectOrgGitFolderResult, String> {
    let org_id = request.org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }

    let org = read_project_org(org_id)?;
    if org.sync_provider != GIT_FOLDER_SYNC_PROVIDER {
        return Err(format!(
            "Org '{}' is not configured for Git folder sync",
            org.name
        ));
    }
    let folder_path = git_folder_path(&org)?;
    ensure_git_worktree(&folder_path)?;

    let orgii_path = folder_path.join(ORGII_DIR);
    let projects_path = orgii_path.join(PROJECTS_DIR);
    fs::create_dir_all(&projects_path)
        .map_err(|err| format!("Failed to create ORGII projects folder: {}", err))?;

    write_json_file(&orgii_path.join(ORG_FILE), &org)?;

    let conflicts = scan_git_folder_conflicts(&folder_path, &projects_path)?;
    if !conflicts.is_empty() {
        return Ok(SyncProjectOrgGitFolderResult {
            org_id: org_id.to_string(),
            folder_path: folder_path.to_string_lossy().to_string(),
            status: ProjectGitFolderSyncStatus::Blocked,
            conflicts,
            last_synced_at: None,
            projects_exported: 0,
            projects_imported: 0,
            work_items_exported: 0,
            work_items_imported: 0,
        });
    }

    let (projects_imported, work_items_imported) = import_files_to_db(org_id, &projects_path)?;
    let (projects_exported, work_items_exported) = export_db_to_files(org_id, &projects_path)?;

    Ok(SyncProjectOrgGitFolderResult {
        org_id: org_id.to_string(),
        folder_path: folder_path.to_string_lossy().to_string(),
        status: ProjectGitFolderSyncStatus::Synced,
        conflicts: Vec::new(),
        last_synced_at: Some(chrono::Utc::now().to_rfc3339()),
        projects_exported,
        projects_imported,
        work_items_exported,
        work_items_imported,
    })
}

pub fn resolve_project_org_git_folder_conflict(
    request: &ResolveProjectOrgGitFolderConflictRequest,
) -> Result<(), String> {
    let org_id = request.org_id.trim();
    if org_id.is_empty() {
        return Err("Org ID is required".to_string());
    }
    let org = read_project_org(org_id)?;
    if org.sync_provider != GIT_FOLDER_SYNC_PROVIDER {
        return Err(format!(
            "Org '{}' is not configured for Git folder sync",
            org.name
        ));
    }
    let folder_path = git_folder_path(&org)?;
    ensure_git_worktree(&folder_path)?;

    let target_path = PathBuf::from(request.file_path.trim());
    if target_path.is_relative() {
        return Err("Conflict file path must be absolute".to_string());
    }
    let canonical_folder = folder_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve Git folder path: {}", err))?;
    let canonical_orgii = canonical_folder.join(ORGII_DIR);
    let canonical_target = target_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve conflict file path: {}", err))?;
    if !canonical_target.starts_with(&canonical_folder) {
        return Err("Conflict file is outside the configured Git folder".to_string());
    }
    if !canonical_target.starts_with(&canonical_orgii) {
        return Err("Conflict file is outside the ORGII sync folder".to_string());
    }
    fs::write(&canonical_target, &request.content).map_err(|err| {
        format!(
            "Failed to write resolved conflict file {}: {}",
            canonical_target.display(),
            err
        )
    })
}

fn scan_git_folder_conflicts(
    folder_path: &Path,
    projects_path: &Path,
) -> Result<Vec<ProjectGitFolderSyncConflict>, String> {
    let mut conflicts = Vec::new();
    if !projects_path.is_dir() {
        return Ok(conflicts);
    }

    for entry in fs::read_dir(projects_path)
        .map_err(|err| format!("Failed to read projects folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read project folder entry: {}", err))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let project_slug = project_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        let project_file_path = project_dir.join(PROJECT_FILE);
        if project_file_path.is_file() {
            scan_json_project_file_conflicts(
                folder_path,
                &project_file_path,
                &project_slug,
                &mut conflicts,
            )?;
        }

        let work_items_dir = project_dir.join(WORK_ITEMS_DIR);
        if work_items_dir.is_dir() {
            for work_item_entry in fs::read_dir(&work_items_dir)
                .map_err(|err| format!("Failed to read work items folder: {}", err))?
            {
                let work_item_entry = work_item_entry
                    .map_err(|err| format!("Failed to read work item file entry: {}", err))?;
                let work_item_path = work_item_entry.path();
                if !work_item_path.is_file()
                    || work_item_path.extension().and_then(|ext| ext.to_str())
                        != Some(MARKDOWN_EXTENSION)
                {
                    continue;
                }
                scan_work_item_file_conflicts(
                    folder_path,
                    &work_item_path,
                    &project_slug,
                    &mut conflicts,
                )?;
            }
        }
    }

    Ok(conflicts)
}

fn scan_json_project_file_conflicts(
    folder_path: &Path,
    path: &Path,
    project_slug: &str,
    conflicts: &mut Vec<ProjectGitFolderSyncConflict>,
) -> Result<(), String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read project file {}: {}", path.display(), err))?;
    if has_git_conflict_markers(&content) {
        conflicts.push(sync_conflict(
            folder_path,
            path,
            SyncConflictInput {
                kind: ProjectGitFolderConflictKind::GitMarker,
                entity_type: ProjectGitFolderConflictEntityType::Project,
                project_slug,
                work_item_short_id: None,
                message: "Project file contains Git conflict markers",
                content: Some(content),
            },
        ));
        return Ok(());
    }
    if let Err(error) = serde_json::from_str::<ProjectFileRecord>(&content) {
        let message = format!("Project file has invalid JSON: {}", error);
        conflicts.push(sync_conflict(
            folder_path,
            path,
            SyncConflictInput {
                kind: ProjectGitFolderConflictKind::ParseError,
                entity_type: ProjectGitFolderConflictEntityType::Project,
                project_slug,
                work_item_short_id: None,
                message: &message,
                content: Some(content),
            },
        ));
    }
    Ok(())
}

fn scan_work_item_file_conflicts(
    folder_path: &Path,
    path: &Path,
    project_slug: &str,
    conflicts: &mut Vec<ProjectGitFolderSyncConflict>,
) -> Result<(), String> {
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read work item file {}: {}", path.display(), err))?;
    let work_item_short_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|value| value.to_string());
    if has_git_conflict_markers(&content) {
        conflicts.push(sync_conflict(
            folder_path,
            path,
            SyncConflictInput {
                kind: ProjectGitFolderConflictKind::GitMarker,
                entity_type: ProjectGitFolderConflictEntityType::WorkItem,
                project_slug,
                work_item_short_id: work_item_short_id.as_deref(),
                message: "Work item file contains Git conflict markers",
                content: Some(content),
            },
        ));
        return Ok(());
    }
    match split_markdown_frontmatter(&content) {
        Some((frontmatter_yaml, _body)) => {
            if let Err(error) = serde_yaml::from_str::<WorkItemFrontmatter>(frontmatter_yaml) {
                let message = format!("Work item frontmatter has invalid YAML: {}", error);
                conflicts.push(sync_conflict(
                    folder_path,
                    path,
                    SyncConflictInput {
                        kind: ProjectGitFolderConflictKind::ParseError,
                        entity_type: ProjectGitFolderConflictEntityType::WorkItem,
                        project_slug,
                        work_item_short_id: work_item_short_id.as_deref(),
                        message: &message,
                        content: Some(content),
                    },
                ));
            }
        }
        None => conflicts.push(sync_conflict(
            folder_path,
            path,
            SyncConflictInput {
                kind: ProjectGitFolderConflictKind::ParseError,
                entity_type: ProjectGitFolderConflictEntityType::WorkItem,
                project_slug,
                work_item_short_id: work_item_short_id.as_deref(),
                message: "Work item file is missing YAML frontmatter",
                content: Some(content),
            },
        )),
    }
    Ok(())
}

struct SyncConflictInput<'a> {
    kind: ProjectGitFolderConflictKind,
    entity_type: ProjectGitFolderConflictEntityType,
    project_slug: &'a str,
    work_item_short_id: Option<&'a str>,
    message: &'a str,
    content: Option<String>,
}

fn sync_conflict(
    folder_path: &Path,
    path: &Path,
    input: SyncConflictInput<'_>,
) -> ProjectGitFolderSyncConflict {
    let relative_path = path
        .strip_prefix(folder_path)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    ProjectGitFolderSyncConflict {
        id: sanitize_file_stem(&relative_path),
        kind: input.kind,
        entity_type: input.entity_type,
        file_path: path.to_string_lossy().to_string(),
        relative_path,
        message: input.message.to_string(),
        project_slug: if input.project_slug.is_empty() {
            None
        } else {
            Some(input.project_slug.to_string())
        },
        work_item_short_id: input.work_item_short_id.map(|value| value.to_string()),
        content: input.content,
    }
}

fn has_git_conflict_markers(content: &str) -> bool {
    content.contains("<<<<<<<") && content.contains("=======") && content.contains(">>>>>>>")
}

fn git_folder_path(org: &ProjectOrg) -> Result<PathBuf, String> {
    let config_json = org
        .sync_config_json
        .as_deref()
        .ok_or_else(|| format!("Org '{}' has no Git folder sync config", org.name))?;
    let config: GitFolderSyncConfig = serde_json::from_str(config_json)
        .map_err(|err| format!("Failed to decode Git folder sync config: {}", err))?;
    let folder_path = config.folder_path.trim();
    if folder_path.is_empty() {
        return Err("Git folder path is required".to_string());
    }
    Ok(PathBuf::from(folder_path))
}

fn ensure_git_worktree(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("Git folder does not exist: {}", path.display()));
    }
    let git_metadata_path = path.join(".git");
    if !git_metadata_path.is_dir() && !git_metadata_path.is_file() {
        return Err(format!(
            "Folder is not a Git working tree: {}",
            path.display()
        ));
    }
    Ok(())
}

fn import_files_to_db(org_id: &str, projects_path: &Path) -> Result<(usize, usize), String> {
    if !projects_path.is_dir() {
        return Ok((0, 0));
    }

    let mut projects_imported = 0;
    let mut work_items_imported = 0;
    for entry in fs::read_dir(projects_path)
        .map_err(|err| format!("Failed to read projects folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read project folder entry: {}", err))?;
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let project_file_path = project_dir.join(PROJECT_FILE);
        if !project_file_path.is_file() {
            continue;
        }

        let mut project_record: ProjectFileRecord = read_json_file(&project_file_path)?;
        project_record.meta.org_id = org_id.to_string();
        let project_slug = project_record.slug.trim().to_string();
        if project_slug.is_empty() {
            return Err(format!(
                "Project file has empty slug: {}",
                project_file_path.display()
            ));
        }

        let should_import_project = should_import_project(&project_slug, org_id, &project_record)?;
        if should_import_project {
            write_project(
                &project_slug,
                &project_record.meta,
                &project_record.description,
                false,
            )?;
            projects_imported += 1;
        }

        let work_items_dir = project_dir.join(WORK_ITEMS_DIR);
        if work_items_dir.is_dir() {
            work_items_imported +=
                import_work_items_for_project(org_id, &project_slug, &work_items_dir)?;
        }
    }

    Ok((projects_imported, work_items_imported))
}

fn should_import_project(
    project_slug: &str,
    org_id: &str,
    record: &ProjectFileRecord,
) -> Result<bool, String> {
    match read_project_scoped(project_slug, Some(org_id)) {
        Ok(existing) => {
            Ok(from_iso8601(&record.meta.updated_at) >= from_iso8601(&existing.meta.updated_at))
        }
        Err(error) if error.contains("not found") => Ok(true),
        Err(error) => Err(error),
    }
}

fn import_work_items_for_project(
    org_id: &str,
    project_slug: &str,
    work_items_dir: &Path,
) -> Result<usize, String> {
    let mut imported = 0;
    for entry in fs::read_dir(work_items_dir)
        .map_err(|err| format!("Failed to read work items folder: {}", err))?
    {
        let entry = entry.map_err(|err| format!("Failed to read work item file entry: {}", err))?;
        let path = entry.path();
        if !path.is_file()
            || path.extension().and_then(|ext| ext.to_str()) != Some(MARKDOWN_EXTENSION)
        {
            continue;
        }
        let work_item = read_work_item_markdown(&path)?;
        let short_id = work_item.frontmatter.short_id.trim();
        if short_id.is_empty() {
            return Err(format!(
                "Work item file has empty short_id: {}",
                path.display()
            ));
        }

        if should_import_work_item(project_slug, short_id, org_id, &work_item)? {
            write_work_item(
                project_slug,
                short_id,
                &work_item.frontmatter,
                &work_item.body,
            )?;
            imported += 1;
        }
    }
    Ok(imported)
}

fn should_import_work_item(
    project_slug: &str,
    short_id: &str,
    org_id: &str,
    work_item: &WorkItemData,
) -> Result<bool, String> {
    match read_work_item_scoped(project_slug, short_id, Some(org_id)) {
        Ok(existing) => Ok(from_iso8601(&work_item.frontmatter.updated_at)
            >= from_iso8601(&existing.frontmatter.updated_at)),
        Err(error) if error.contains("not found") => Ok(true),
        Err(error) => Err(error),
    }
}

fn export_db_to_files(org_id: &str, projects_path: &Path) -> Result<(usize, usize), String> {
    let projects = read_all_projects_scoped(Some(org_id))?;
    let mut projects_exported = 0;
    let mut work_items_exported = 0;

    for project in projects {
        let project_dir = projects_path.join(&project.slug);
        let work_items_dir = project_dir.join(WORK_ITEMS_DIR);
        fs::create_dir_all(&work_items_dir)
            .map_err(|err| format!("Failed to create project sync folder: {}", err))?;

        let project_record = ProjectFileRecord {
            slug: project.slug.clone(),
            meta: project.meta.clone(),
            description: project.description.clone(),
        };
        write_json_file(&project_dir.join(PROJECT_FILE), &project_record)?;
        projects_exported += 1;

        for work_item in read_all_work_items_scoped(&project.slug, Some(org_id))? {
            let file_name = format!(
                "{}.{}",
                sanitize_file_stem(&work_item.frontmatter.short_id),
                MARKDOWN_EXTENSION
            );
            write_work_item_markdown(&work_items_dir.join(file_name), &work_item)?;
            work_items_exported += 1;
        }
    }

    Ok((projects_exported, work_items_exported))
}

fn sanitize_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn read_json_file<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let contents = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read JSON file {}: {}", path.display(), err))?;
    serde_json::from_str(&contents)
        .map_err(|err| format!("Failed to parse JSON file {}: {}", path.display(), err))
}

fn write_json_file<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {}", parent.display(), err))?;
    }
    let contents = serde_json::to_string_pretty(value)
        .map_err(|err| format!("Failed to encode JSON file {}: {}", path.display(), err))?;
    fs::write(path, format!("{}\n", contents))
        .map_err(|err| format!("Failed to write JSON file {}: {}", path.display(), err))
}

fn read_work_item_markdown(path: &Path) -> Result<WorkItemData, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("Failed to read work item file {}: {}", path.display(), err))?;
    let (frontmatter_yaml, body) = split_markdown_frontmatter(&raw).ok_or_else(|| {
        format!(
            "Work item file missing YAML frontmatter: {}",
            path.display()
        )
    })?;
    let frontmatter: WorkItemFrontmatter =
        serde_yaml::from_str(frontmatter_yaml).map_err(|err| {
            format!(
                "Failed to parse work item frontmatter {}: {}",
                path.display(),
                err
            )
        })?;
    let filename = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(&frontmatter.short_id)
        .to_string();
    Ok(WorkItemData {
        frontmatter,
        body: body.to_string(),
        filename,
    })
}

fn write_work_item_markdown(path: &Path, work_item: &WorkItemData) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create folder {}: {}", parent.display(), err))?;
    }
    // Execution state stays out of the git-synced markdown: sessions and
    // orchestrator runs are per-device runtime facts, not durable spec.
    let mut frontmatter_for_export = work_item.frontmatter.clone();
    frontmatter_for_export.linked_sessions = Vec::new();
    frontmatter_for_export.origin_session = None;
    frontmatter_for_export.orchestrator_state = None;
    let frontmatter = serde_yaml::to_string(&frontmatter_for_export)
        .map_err(|err| format!("Failed to encode work item frontmatter: {}", err))?;
    let contents = format!("---\n{}---\n{}", frontmatter, work_item.body);
    fs::write(path, contents)
        .map_err(|err| format!("Failed to write work item file {}: {}", path.display(), err))
}

fn split_markdown_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    let frontmatter = &rest[..end];
    let body = &rest[end + "\n---\n".len()..];
    Some((frontmatter, body))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::projects::io::{configure_project_org_git_folder_sync, create_project_org};
    use crate::projects::types::{
        ConfigureProjectOrgGitFolderSyncRequest, CreateProjectOrgRequest, ProjectMeta,
        WorkItemFrontmatter, WorkItemHistoryAction,
    };
    use test_helpers::test_env;

    fn project_meta(id: &str, name: &str, org_id: &str, updated_at: &str) -> ProjectMeta {
        ProjectMeta {
            id: id.to_string(),
            name: name.to_string(),
            org_id: org_id.to_string(),
            status: "planned".to_string(),
            priority: "none".to_string(),
            health: "no_updates".to_string(),
            lead: None,
            members: Vec::new(),
            labels: Vec::new(),
            linked_repos: Vec::new(),
            start_date: None,
            target_date: None,
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            updated_at: updated_at.to_string(),
            next_work_item_id: 1,
            work_item_prefix: "ALP".to_string(),
            work_item_prefix_custom: true,
            agent_defaults: None,
        }
    }

    fn work_item_frontmatter(
        id: &str,
        short_id: &str,
        title: &str,
        updated_at: &str,
    ) -> WorkItemFrontmatter {
        WorkItemFrontmatter {
            id: id.to_string(),
            short_id: short_id.to_string(),
            title: title.to_string(),
            project: None,
            status: "todo".to_string(),
            priority: "none".to_string(),
            assignee: None,
            assignee_type: None,
            labels: Vec::new(),
            milestone: None,
            parent: None,
            stage: None,
            start_date: None,
            target_date: None,
            created_by: None,
            origin_session: None,
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            updated_at: updated_at.to_string(),
            deleted_at: None,
            starred: false,
            todos: Vec::new(),
            comments: Vec::new(),
            history: Vec::new(),
            delegations: Vec::new(),
            linked_sessions: Vec::new(),
            handoff: None,
            proof_of_work: None,
            orchestrator_config: None,
            orchestrator_state: None,
            follow_up_items: Vec::new(),
            schedule: None,
            routine_source: None,
            execution_lock: None,
            close_out: None,
            work_products: Vec::new(),
        }
    }

    fn create_git_bound_org(folder: &Path) -> String {
        let org = create_project_org(&CreateProjectOrgRequest {
            name: "Sync Team".to_string(),
            id: None,
        })
        .expect("create org");
        fs::create_dir_all(folder.join(".git")).expect("create git metadata");
        configure_project_org_git_folder_sync(&ConfigureProjectOrgGitFolderSyncRequest {
            org_id: org.id.clone(),
            folder_path: folder.to_string_lossy().to_string(),
        })
        .expect("configure sync");
        org.id
    }

    #[test]
    fn sync_project_org_git_folder_exports_and_imports_round_trip() {
        let _sandbox = test_env::sandbox();
        let temp = tempfile::tempdir().expect("tempdir");
        let org_id = create_git_bound_org(temp.path());

        write_project(
            "alpha",
            &project_meta(
                "project-alpha",
                "Alpha",
                &org_id,
                "2026-01-02T00:00:00+00:00",
            ),
            "Alpha description",
            false,
        )
        .expect("write project");
        write_work_item(
            "alpha",
            "ALP-0001",
            &work_item_frontmatter(
                "work-alpha-1",
                "ALP-0001",
                "First item",
                "2026-01-02T00:00:00+00:00",
            ),
            "First body",
        )
        .expect("write work item");

        let result = sync_project_org_git_folder(&SyncProjectOrgGitFolderRequest {
            org_id: org_id.clone(),
        })
        .expect("sync export");
        assert_eq!(result.projects_exported, 1);
        assert_eq!(result.work_items_exported, 1);

        let work_item_path = temp
            .path()
            .join(".orgii/projects/alpha/work-items/ALP-0001.md");
        let mut file_work_item =
            read_work_item_markdown(&work_item_path).expect("read exported item");
        assert_eq!(file_work_item.frontmatter.history.len(), 1);
        assert_eq!(
            file_work_item.frontmatter.history[0].action,
            WorkItemHistoryAction::Created
        );
        file_work_item.frontmatter.title = "File edited item".to_string();
        file_work_item.frontmatter.updated_at = "2026-01-03T00:00:00+00:00".to_string();
        file_work_item.body = "File edited body".to_string();
        write_work_item_markdown(&work_item_path, &file_work_item).expect("write edited item");

        let result = sync_project_org_git_folder(&SyncProjectOrgGitFolderRequest { org_id })
            .expect("sync import");
        assert_eq!(result.work_items_imported, 1);
        let imported =
            read_work_item_scoped("alpha", "ALP-0001", None).expect("read imported item");
        assert_eq!(imported.frontmatter.title, "File edited item");
        assert_eq!(imported.body, "File edited body");
        assert_eq!(imported.frontmatter.history.len(), 1);
        assert_eq!(
            imported.frontmatter.history[0].action,
            WorkItemHistoryAction::Created
        );
    }

    #[test]
    fn sync_project_org_git_folder_blocks_on_git_marker_conflict() {
        let _sandbox = test_env::sandbox();
        let temp = tempfile::tempdir().expect("tempdir");
        let org_id = create_git_bound_org(temp.path());
        let project_dir = temp.path().join(".orgii/projects/alpha");
        fs::create_dir_all(&project_dir).expect("project dir");
        fs::write(
            project_dir.join(PROJECT_FILE),
            "<<<<<<< HEAD\n{\"slug\":\"alpha\"}\n=======\n{\"slug\":\"beta\"}\n>>>>>>> branch\n",
        )
        .expect("write conflict file");

        let result = sync_project_org_git_folder(&SyncProjectOrgGitFolderRequest { org_id })
            .expect("sync blocks");
        assert!(matches!(result.status, ProjectGitFolderSyncStatus::Blocked));
        assert_eq!(result.conflicts.len(), 1);
        assert!(matches!(
            result.conflicts[0].kind,
            ProjectGitFolderConflictKind::GitMarker
        ));
        assert_eq!(result.projects_imported, 0);
        assert_eq!(result.projects_exported, 0);
    }

    #[test]
    fn sync_project_org_git_folder_blocks_on_parse_error() {
        let _sandbox = test_env::sandbox();
        let temp = tempfile::tempdir().expect("tempdir");
        let org_id = create_git_bound_org(temp.path());
        let work_items_dir = temp.path().join(".orgii/projects/alpha/work-items");
        fs::create_dir_all(&work_items_dir).expect("work items dir");
        fs::write(
            work_items_dir.join("ALP-0001.md"),
            "---\nshort_id: [broken\n---\nBody\n",
        )
        .expect("write invalid work item");

        let result = sync_project_org_git_folder(&SyncProjectOrgGitFolderRequest { org_id })
            .expect("sync blocks");
        assert!(matches!(result.status, ProjectGitFolderSyncStatus::Blocked));
        assert_eq!(result.conflicts.len(), 1);
        assert!(matches!(
            result.conflicts[0].kind,
            ProjectGitFolderConflictKind::ParseError
        ));
        assert_eq!(result.work_items_imported, 0);
        assert_eq!(result.work_items_exported, 0);
    }

    #[test]
    fn sync_project_org_git_folder_keeps_newer_db_over_stale_file() {
        let _sandbox = test_env::sandbox();
        let temp = tempfile::tempdir().expect("tempdir");
        let org_id = create_git_bound_org(temp.path());

        write_project(
            "alpha",
            &project_meta(
                "project-alpha",
                "Alpha",
                &org_id,
                "2026-01-03T00:00:00+00:00",
            ),
            "New DB description",
            false,
        )
        .expect("write project");
        let project_dir = temp.path().join(".orgii/projects/alpha");
        fs::create_dir_all(&project_dir).expect("project dir");
        write_json_file(
            &project_dir.join(PROJECT_FILE),
            &ProjectFileRecord {
                slug: "alpha".to_string(),
                meta: project_meta(
                    "project-alpha",
                    "Alpha stale",
                    &org_id,
                    "2026-01-02T00:00:00+00:00",
                ),
                description: "Stale file description".to_string(),
            },
        )
        .expect("write stale file");

        let result = sync_project_org_git_folder(&SyncProjectOrgGitFolderRequest {
            org_id: org_id.clone(),
        })
        .expect("sync");
        assert_eq!(result.projects_imported, 0);
        let project = read_project_scoped("alpha", Some(&org_id)).expect("read project");
        assert_eq!(project.meta.name, "Alpha");
        assert_eq!(project.description, "New DB description");
    }
}
