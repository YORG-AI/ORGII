use std::collections::{HashMap, HashSet, VecDeque};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::paths::{canonical_workspace, db_path_for_workspace};
use crate::types::{
    CodeMapConfidence, CodeMapEdge, CodeMapEdgeKind, CodeMapExtractionMethod, CodeMapFreshnessKind,
    CodeMapLanguage, CodeMapNode, CodeMapNodeKind, CodeMapRelationship, CodeMapResolutionStatus,
    CodeMapSearchResult, CodeMapStatus, CodeMapStatusKind, ExtractedFile, EXTRACTOR_VERSION,
    SCHEMA_VERSION,
};
use crate::{CodeMapError, Result};

const NODE_SELECT_COLUMNS: &str = "id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature, updated_at, confidence, extraction_method, parent_id";
const NODE_SELECT_COLUMNS_QUALIFIED: &str = "nodes.id, nodes.kind, nodes.name, nodes.qualified_name, nodes.file_path, nodes.language, nodes.start_line, nodes.end_line, nodes.start_column, nodes.end_column, nodes.signature, nodes.updated_at, nodes.confidence, nodes.extraction_method, nodes.parent_id";
const EDGE_SELECT_COLUMNS_QUALIFIED: &str = "edges.source, edges.target, edges.kind, edges.line, edges.column, edges.provenance, edges.confidence, edges.resolution_status";
const CREATE_NODES_FTS_SQL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  id UNINDEXED,
  name,
  qualified_name,
  file_path,
  signature,
  content=''
)";

pub struct CodeMapDb {
    conn: Connection,
    workspace_path: String,
    db_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct FreshnessScan {
    pub added: Vec<PathBuf>,
    pub modified: Vec<PathBuf>,
    pub deleted: Vec<String>,
    pub requires_full_rebuild: bool,
}

impl FreshnessScan {
    pub fn changed_count(&self) -> usize {
        self.added.len() + self.modified.len() + self.deleted.len()
    }

    pub fn is_fresh(&self) -> bool {
        self.changed_count() == 0 && !self.requires_full_rebuild
    }
}

impl CodeMapDb {
    pub fn open(workspace_path: &Path) -> Result<Self> {
        let canonical_root = canonical_workspace(workspace_path)?;
        let db_path = db_path_for_workspace(&canonical_root)?;
        let conn = Connection::open(&db_path)?;
        let workspace_path = canonical_root.to_string_lossy().to_string();
        let this = Self {
            conn,
            workspace_path,
            db_path,
        };
        this.migrate()?;
        Ok(this)
    }

    pub fn delete_for_workspace(workspace_path: &Path) -> Result<()> {
        let canonical_root = canonical_workspace(workspace_path)?;
        let db_path = db_path_for_workspace(&canonical_root)?;
        remove_database_file(&db_path)?;
        for suffix in ["-wal", "-shm"] {
            remove_database_file(&PathBuf::from(format!(
                "{}{}",
                db_path.to_string_lossy(),
                suffix
            )))?;
        }
        Ok(())
    }

    fn migrate(&self) -> Result<()> {
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS files (
               path TEXT PRIMARY KEY,
               content_hash TEXT NOT NULL,
               language TEXT NOT NULL,
               size INTEGER NOT NULL,
               modified_at INTEGER NOT NULL,
               indexed_at INTEGER NOT NULL,
               node_count INTEGER NOT NULL DEFAULT 0,
               errors_json TEXT NOT NULL DEFAULT '[]',
               stale INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS nodes (
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               name TEXT NOT NULL,
               qualified_name TEXT NOT NULL,
               file_path TEXT NOT NULL,
               language TEXT NOT NULL,
               start_line INTEGER NOT NULL,
               end_line INTEGER NOT NULL,
               start_column INTEGER NOT NULL,
               end_column INTEGER NOT NULL,
               signature TEXT,
               updated_at INTEGER NOT NULL,
               confidence TEXT NOT NULL DEFAULT 'heuristic',
               extraction_method TEXT NOT NULL DEFAULT 'regex',
               parent_id TEXT,
               FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE,
               FOREIGN KEY(parent_id) REFERENCES nodes(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
             CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
             CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
             CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
             CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
             CREATE TABLE IF NOT EXISTS edges (
               source TEXT NOT NULL,
               target TEXT NOT NULL,
               kind TEXT NOT NULL,
               line INTEGER,
               column INTEGER,
               provenance TEXT,
               confidence TEXT NOT NULL DEFAULT 'heuristic',
               resolution_status TEXT NOT NULL DEFAULT 'resolved',
               PRIMARY KEY(source, target, kind, line, column),
               FOREIGN KEY(source) REFERENCES nodes(id) ON DELETE CASCADE,
               FOREIGN KEY(target) REFERENCES nodes(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
             CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);
             CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
             CREATE TABLE IF NOT EXISTS unresolved_refs (
               file_path TEXT NOT NULL,
               from_node_id TEXT,
               name TEXT NOT NULL,
               kind TEXT NOT NULL,
               language TEXT NOT NULL DEFAULT 'typescript',
               line INTEGER NOT NULL,
               column INTEGER NOT NULL,
               candidates_json TEXT NOT NULL DEFAULT '[]',
               reason TEXT,
               FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE,
               FOREIGN KEY(from_node_id) REFERENCES nodes(id) ON DELETE SET NULL
             );
             CREATE INDEX IF NOT EXISTS idx_unresolved_refs_file_path ON unresolved_refs(file_path);
             CREATE INDEX IF NOT EXISTS idx_unresolved_refs_name ON unresolved_refs(name);",
        )?;
        self.conn.execute(CREATE_NODES_FTS_SQL, [])?;
        self.ensure_column("files", "stale", "INTEGER NOT NULL DEFAULT 0")?;
        self.ensure_column("nodes", "confidence", "TEXT NOT NULL DEFAULT 'heuristic'")?;
        self.ensure_column(
            "nodes",
            "extraction_method",
            "TEXT NOT NULL DEFAULT 'regex'",
        )?;
        self.ensure_column("nodes", "parent_id", "TEXT")?;
        self.ensure_column("edges", "confidence", "TEXT NOT NULL DEFAULT 'heuristic'")?;
        self.ensure_column(
            "edges",
            "resolution_status",
            "TEXT NOT NULL DEFAULT 'resolved'",
        )?;
        self.ensure_column("unresolved_refs", "from_node_id", "TEXT")?;
        self.ensure_column(
            "unresolved_refs",
            "language",
            "TEXT NOT NULL DEFAULT 'typescript'",
        )?;
        self.ensure_column(
            "unresolved_refs",
            "candidates_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        self.ensure_column("unresolved_refs", "reason", "TEXT")?;
        self.set_metadata("schema_version", &SCHEMA_VERSION.to_string())?;
        self.set_metadata("extractor_version", EXTRACTOR_VERSION)?;
        self.set_metadata("workspace_path", &self.workspace_path)?;
        Ok(())
    }

    fn ensure_column(&self, table: &str, column: &str, definition: &str) -> Result<()> {
        let mut statement = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        for existing in columns {
            if existing? == column {
                return Ok(());
            }
        }
        self.conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
        Ok(())
    }

    fn set_metadata(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO metadata(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn set_status(&self, status: CodeMapStatusKind, error: Option<&str>) -> Result<()> {
        self.set_metadata("status", status.as_str())?;
        self.set_metadata("status_updated_at", &Utc::now().timestamp().to_string())?;
        if let Some(error) = error {
            self.set_metadata("last_error", error)?;
        } else {
            self.conn
                .execute("DELETE FROM metadata WHERE key = 'last_error'", [])?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn mark_indexing_for_test(&self) -> Result<()> {
        self.set_status(CodeMapStatusKind::Indexing, None)
    }

    pub fn apply_index_changes_with_cancellation(
        &mut self,
        extracted_files: Vec<ExtractedFile>,
        deleted_files: &[String],
        cancellation: Option<&AtomicBool>,
    ) -> Result<()> {
        let workspace_path = self.workspace_path.clone();
        check_cancelled(cancellation, &workspace_path)?;
        let transaction = self.conn.transaction()?;
        for file_path in deleted_files {
            check_cancelled(cancellation, &workspace_path)?;
            transaction.execute("DELETE FROM files WHERE path = ?1", params![file_path])?;
        }

        for extracted in &extracted_files {
            check_cancelled(cancellation, &workspace_path)?;
            transaction.execute(
                "DELETE FROM unresolved_refs WHERE file_path = ?1",
                params![extracted.record.path],
            )?;
            transaction.execute(
                "DELETE FROM files WHERE path = ?1",
                params![extracted.record.path],
            )?;
        }

        for extracted in &extracted_files {
            check_cancelled(cancellation, &workspace_path)?;
            let errors_json = serde_json::to_string(&extracted.record.errors)
                .unwrap_or_else(|_| String::from("[]"));
            transaction.execute(
                "INSERT INTO files(path, content_hash, language, size, modified_at, indexed_at, node_count, errors_json, stale)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    extracted.record.path,
                    extracted.record.content_hash,
                    extracted.record.language.as_str(),
                    extracted.record.size,
                    extracted.record.modified_at,
                    extracted.record.indexed_at,
                    extracted.nodes.len() as u32,
                    errors_json,
                    bool_to_int(extracted.record.stale),
                ],
            )?;
        }

        for extracted in &extracted_files {
            check_cancelled(cancellation, &workspace_path)?;
            for node in &extracted.nodes {
                check_cancelled(cancellation, &workspace_path)?;
                transaction.execute(
                    "INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, signature, updated_at, confidence, extraction_method, parent_id)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        node.id,
                        node.kind.as_str(),
                        node.name,
                        node.qualified_name,
                        node.file_path,
                        node.language.as_str(),
                        node.start_line,
                        node.end_line,
                        node.start_column,
                        node.end_column,
                        node.signature,
                        node.updated_at,
                        node.confidence.as_str(),
                        node.extraction_method.as_str(),
                        node.parent_id,
                    ],
                )?;
            }
        }

        for extracted in extracted_files {
            check_cancelled(cancellation, &workspace_path)?;
            for edge in extracted.edges {
                check_cancelled(cancellation, &workspace_path)?;
                transaction.execute(
                    "INSERT OR IGNORE INTO edges(source, target, kind, line, column, provenance, confidence, resolution_status)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        edge.source,
                        edge.target,
                        edge.kind.as_str(),
                        edge.line,
                        edge.column,
                        edge.provenance,
                        edge.confidence.as_str(),
                        edge.resolution_status.as_str(),
                    ],
                )?;
            }

            for unresolved in extracted.unresolved_refs {
                check_cancelled(cancellation, &workspace_path)?;
                let candidates_json = serde_json::to_string(&unresolved.candidates)
                    .unwrap_or_else(|_| String::from("[]"));
                transaction.execute(
                    "INSERT INTO unresolved_refs(file_path, from_node_id, name, kind, language, line, column, candidates_json, reason)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        unresolved.file_path,
                        unresolved.from_node_id,
                        unresolved.name,
                        unresolved.kind.as_str(),
                        unresolved.language.as_str(),
                        unresolved.line,
                        unresolved.column,
                        candidates_json,
                        unresolved.reason,
                    ],
                )?;
            }
        }

        check_cancelled(cancellation, &workspace_path)?;
        rebuild_fts(&transaction)?;
        check_cancelled(cancellation, &workspace_path)?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('last_indexed_at', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![Utc::now().timestamp().to_string()],
        )?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES('status', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![CodeMapStatusKind::Ready.as_str()],
        )?;
        transaction.execute("DELETE FROM metadata WHERE key = 'last_error'", [])?;
        check_cancelled(cancellation, &workspace_path)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn status(&self) -> Result<CodeMapStatus> {
        let files = self.count("files")?;
        let symbols = self.count("nodes")?;
        let relationships = self.count("edges")?;
        let unresolved = self.count("unresolved_refs")?;
        let stale_files = self.count_stale_files()?;
        let index_size_bytes = database_size_bytes(&self.db_path)?;
        let mut status = self
            .metadata("status")?
            .as_deref()
            .and_then(parse_status)
            .unwrap_or(if files == 0 {
                CodeMapStatusKind::NotIndexed
            } else {
                CodeMapStatusKind::Ready
            });
        if matches!(status, CodeMapStatusKind::Ready) && stale_files > 0 {
            status = CodeMapStatusKind::Stale;
        }
        let freshness = if files == 0 {
            CodeMapFreshnessKind::Unknown
        } else if stale_files > 0 {
            CodeMapFreshnessKind::Stale
        } else {
            CodeMapFreshnessKind::Fresh
        };
        let last_indexed_at = self
            .metadata("last_indexed_at")?
            .and_then(|value| value.parse::<i64>().ok());
        let error = self.metadata("last_error")?;
        Ok(CodeMapStatus {
            workspace_path: self.workspace_path.clone(),
            status,
            files,
            symbols,
            relationships,
            unresolved,
            stale_files,
            index_size_bytes,
            freshness,
            last_indexed_at,
            error,
            progress: None,
        })
    }

    fn count(&self, table: &str) -> Result<u32> {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        let count: i64 = self.conn.query_row(&sql, [], |row| row.get(0))?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    fn count_stale_files(&self) -> Result<u32> {
        let count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM files WHERE stale = 1", [], |row| {
                    row.get(0)
                })?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    fn metadata(&self, key: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT value FROM metadata WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn stored_file_hashes(&self) -> Result<HashMap<String, (String, i64)>> {
        let mut statement = self
            .conn
            .prepare("SELECT path, content_hash, modified_at FROM files")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (row.get::<_, String>(1)?, row.get::<_, i64>(2)?),
            ))
        })?;
        let mut values = HashMap::new();
        for row in rows {
            let (path, metadata) = row?;
            values.insert(path, metadata);
        }
        Ok(values)
    }

    pub fn stored_file_paths(&self) -> Result<Vec<String>> {
        let mut statement = self.conn.prepare("SELECT path FROM files")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        collect_rows(rows)
    }

    pub fn mark_stale_files(&self, stale_files: &[String]) -> Result<()> {
        self.conn.execute("UPDATE files SET stale = 0", [])?;
        for file_path in stale_files {
            self.conn.execute(
                "UPDATE files SET stale = 1 WHERE path = ?1",
                params![file_path],
            )?;
        }
        if stale_files.is_empty() {
            if matches!(self.status()?.status, CodeMapStatusKind::Stale) {
                self.set_status(CodeMapStatusKind::Ready, None)?;
            }
        } else {
            self.set_status(CodeMapStatusKind::Stale, None)?;
        }
        Ok(())
    }

    pub fn requires_full_rebuild(&self) -> Result<bool> {
        let schema_version_matches = self
            .metadata("schema_version")?
            .and_then(|value| value.parse::<i64>().ok())
            == Some(SCHEMA_VERSION);
        let extractor_version_matches =
            self.metadata("extractor_version")?.as_deref() == Some(EXTRACTOR_VERSION);
        Ok(!schema_version_matches || !extractor_version_matches)
    }

    pub fn search_nodes(
        &self,
        query: &str,
        max_results: usize,
        kind: Option<CodeMapNodeKind>,
        language: Option<CodeMapLanguage>,
        path_prefix: Option<&str>,
    ) -> Result<Vec<CodeMapSearchResult>> {
        let mut results = self.search_nodes_fts(query, max_results, kind, language, path_prefix)?;
        if results.is_empty() {
            results = self.search_nodes_like(query, max_results, kind, language, path_prefix)?;
        }
        Ok(results)
    }

    fn search_nodes_fts(
        &self,
        query: &str,
        max_results: usize,
        kind: Option<CodeMapNodeKind>,
        language: Option<CodeMapLanguage>,
        path_prefix: Option<&str>,
    ) -> Result<Vec<CodeMapSearchResult>> {
        let fts_query = format_fts_query(query);
        let mut statement = self.conn.prepare(&format!(
            "SELECT {NODE_SELECT_COLUMNS_QUALIFIED}, bm25(nodes_fts) AS rank
             FROM nodes_fts JOIN nodes ON nodes_fts.id = nodes.id
             WHERE nodes_fts MATCH ?1
               AND (?2 IS NULL OR nodes.kind = ?2)
               AND (?3 IS NULL OR nodes.language = ?3)
               AND (?4 IS NULL OR nodes.file_path LIKE ?4)
             ORDER BY rank, length(nodes.qualified_name), nodes.qualified_name
             LIMIT ?5"
        ))?;
        let path_like = path_prefix.map(|value| format!("{value}%"));
        let rows = statement.query_map(
            params![
                fts_query,
                kind.map(CodeMapNodeKind::as_str),
                language.map(CodeMapLanguage::as_str),
                path_like,
                max_results as i64,
            ],
            |row| {
                let node = row_to_node_offset(row, 0)?;
                let rank = row.get::<_, f64>(15)?.abs();
                Ok(CodeMapSearchResult {
                    incoming_count: 0,
                    outgoing_count: 0,
                    node,
                    rank,
                    source: None,
                })
            },
        )?;
        self.with_relationship_counts(collect_rows(rows)?)
    }

    fn search_nodes_like(
        &self,
        query: &str,
        max_results: usize,
        kind: Option<CodeMapNodeKind>,
        language: Option<CodeMapLanguage>,
        path_prefix: Option<&str>,
    ) -> Result<Vec<CodeMapSearchResult>> {
        let like = format!("%{}%", query);
        let path_like = path_prefix.map(|value| format!("{value}%"));
        let mut statement = self.conn.prepare(&format!(
            "SELECT {NODE_SELECT_COLUMNS}
             FROM nodes
             WHERE (name LIKE ?1 OR qualified_name LIKE ?1 OR file_path LIKE ?1 OR signature LIKE ?1)
               AND (?3 IS NULL OR kind = ?3)
               AND (?4 IS NULL OR language = ?4)
               AND (?5 IS NULL OR file_path LIKE ?5)
             ORDER BY CASE WHEN name = ?2 THEN 0 WHEN name LIKE ?1 THEN 1 ELSE 2 END, length(qualified_name), qualified_name
             LIMIT ?6"
        ))?;
        let rows = statement.query_map(
            params![
                like,
                query,
                kind.map(CodeMapNodeKind::as_str),
                language.map(CodeMapLanguage::as_str),
                path_like,
                max_results as i64,
            ],
            |row| {
                let node = row_to_node(row)?;
                Ok(CodeMapSearchResult {
                    incoming_count: 0,
                    outgoing_count: 0,
                    node,
                    rank: 100.0,
                    source: None,
                })
            },
        )?;
        self.with_relationship_counts(collect_rows(rows)?)
    }

    fn with_relationship_counts(
        &self,
        results: Vec<CodeMapSearchResult>,
    ) -> Result<Vec<CodeMapSearchResult>> {
        let mut with_counts = Vec::with_capacity(results.len());
        for mut result in results {
            result.incoming_count = self.count_edges_for_node(&result.node.id, true)?;
            result.outgoing_count = self.count_edges_for_node(&result.node.id, false)?;
            with_counts.push(result);
        }
        Ok(with_counts)
    }

    fn count_edges_for_node(&self, node_id: &str, incoming: bool) -> Result<u32> {
        let column = if incoming { "target" } else { "source" };
        let count: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM edges WHERE {column} = ?1"),
            params![node_id],
            |row| row.get(0),
        )?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    pub fn node_by_id(&self, node_id: &str) -> Result<Option<CodeMapNode>> {
        self.conn
            .query_row(
                &format!("SELECT {NODE_SELECT_COLUMNS} FROM nodes WHERE id = ?1"),
                params![node_id],
                row_to_node,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn node_by_file_path(
        &self,
        file_path: &str,
        max_results: usize,
    ) -> Result<Vec<CodeMapNode>> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT {NODE_SELECT_COLUMNS}
             FROM nodes WHERE file_path = ?1 ORDER BY start_line, start_column LIMIT ?2"
        ))?;
        let rows = statement.query_map(params![file_path, max_results as i64], row_to_node)?;
        collect_rows(rows)
    }

    pub fn edges_for_node(
        &self,
        node_id: &str,
        incoming: bool,
        max_results: usize,
        semantic_only: bool,
    ) -> Result<Vec<CodeMapRelationship>> {
        let edge_join = if incoming {
            "edges.source = nodes.id WHERE edges.target = ?1"
        } else {
            "edges.target = nodes.id WHERE edges.source = ?1"
        };
        let semantic_filter = if semantic_only {
            " AND edges.kind != 'contains'"
        } else {
            ""
        };
        let sql = format!(
            "SELECT {EDGE_SELECT_COLUMNS_QUALIFIED}, {NODE_SELECT_COLUMNS_QUALIFIED}
             FROM edges JOIN nodes ON {edge_join}{semantic_filter}
             ORDER BY edges.kind, nodes.qualified_name LIMIT ?2"
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params![node_id, max_results as i64], |row| {
            let edge = row_to_edge(row, 0)?;
            let node = row_to_node_offset(row, 8)?;
            Ok(CodeMapRelationship { edge, node })
        })?;
        collect_rows(rows)
    }

    pub fn impact(
        &self,
        node_id: &str,
        max_depth: usize,
        max_results: usize,
    ) -> Result<Vec<CodeMapNode>> {
        let mut visited = HashSet::new();
        let mut queue = VecDeque::new();
        let mut results = Vec::new();
        visited.insert(node_id.to_string());
        queue.push_back((node_id.to_string(), 0usize));

        while let Some((current, depth)) = queue.pop_front() {
            if depth >= max_depth || results.len() >= max_results {
                continue;
            }
            for relationship in self.edges_for_node(&current, true, max_results, true)? {
                if !relationship.edge.kind.is_semantic_dependency() {
                    continue;
                }
                if visited.insert(relationship.node.id.clone()) {
                    queue.push_back((relationship.node.id.clone(), depth + 1));
                    results.push(relationship.node);
                    if results.len() >= max_results {
                        break;
                    }
                }
            }
        }
        Ok(results)
    }
}

fn check_cancelled(cancellation: Option<&AtomicBool>, workspace_path: &str) -> Result<()> {
    if cancellation.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(CodeMapError::Cancelled(workspace_path.to_string()));
    }
    Ok(())
}

fn rebuild_fts(transaction: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    transaction.execute("DROP TABLE IF EXISTS nodes_fts", [])?;
    transaction.execute(CREATE_NODES_FTS_SQL, [])?;
    transaction.execute(
        "INSERT INTO nodes_fts(id, name, qualified_name, file_path, signature)
         SELECT id, name, qualified_name, file_path, COALESCE(signature, '') FROM nodes",
        [],
    )?;
    Ok(())
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>> {
    let mut values = Vec::new();
    for row in rows {
        values.push(row?);
    }
    Ok(values)
}

fn database_size_bytes(db_path: &Path) -> Result<u64> {
    let mut total = path_size_bytes(db_path)?;
    for suffix in ["-wal", "-shm"] {
        total = total.saturating_add(path_size_bytes(&PathBuf::from(format!(
            "{}{}",
            db_path.to_string_lossy(),
            suffix
        )))?);
    }
    Ok(total)
}

fn path_size_bytes(path: &Path) -> Result<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn remove_database_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn format_fts_query(query: &str) -> String {
    let terms = query
        .split_whitespace()
        .map(|term| {
            term.chars()
                .filter(|character| {
                    character.is_alphanumeric() || *character == '_' || *character == '-'
                })
                .collect::<String>()
        })
        .filter(|term| !term.is_empty())
        .map(|term| format!("{term}*"))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        query.replace('"', "")
    } else {
        terms.join(" OR ")
    }
}

fn row_to_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeMapNode> {
    row_to_node_offset(row, 0)
}

fn row_to_node_offset(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CodeMapNode> {
    Ok(CodeMapNode {
        id: row.get(offset)?,
        kind: parse_node_kind(&row.get::<_, String>(offset + 1)?),
        name: row.get(offset + 2)?,
        qualified_name: row.get(offset + 3)?,
        file_path: row.get(offset + 4)?,
        language: parse_language(&row.get::<_, String>(offset + 5)?),
        start_line: row.get(offset + 6)?,
        end_line: row.get(offset + 7)?,
        start_column: row.get(offset + 8)?,
        end_column: row.get(offset + 9)?,
        signature: row.get(offset + 10)?,
        updated_at: row.get(offset + 11)?,
        confidence: parse_confidence(&row.get::<_, String>(offset + 12)?),
        extraction_method: parse_extraction_method(&row.get::<_, String>(offset + 13)?),
        parent_id: row.get(offset + 14)?,
    })
}

fn row_to_edge(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<CodeMapEdge> {
    Ok(CodeMapEdge {
        source: row.get(offset)?,
        target: row.get(offset + 1)?,
        kind: parse_edge_kind(&row.get::<_, String>(offset + 2)?),
        line: row.get(offset + 3)?,
        column: row.get(offset + 4)?,
        provenance: row.get(offset + 5)?,
        confidence: parse_confidence(&row.get::<_, String>(offset + 6)?),
        resolution_status: parse_resolution_status(&row.get::<_, String>(offset + 7)?),
    })
}

fn parse_status(value: &str) -> Option<CodeMapStatusKind> {
    match value {
        "not_indexed" => Some(CodeMapStatusKind::NotIndexed),
        "indexing" => Some(CodeMapStatusKind::Indexing),
        "ready" => Some(CodeMapStatusKind::Ready),
        "stale" => Some(CodeMapStatusKind::Stale),
        "failed" => Some(CodeMapStatusKind::Failed),
        "cancelled" => Some(CodeMapStatusKind::Cancelled),
        _ => None,
    }
}

fn parse_language(value: &str) -> CodeMapLanguage {
    match value {
        "typescript" => CodeMapLanguage::TypeScript,
        "tsx" => CodeMapLanguage::Tsx,
        "javascript" => CodeMapLanguage::JavaScript,
        "jsx" => CodeMapLanguage::Jsx,
        "python" => CodeMapLanguage::Python,
        "go" => CodeMapLanguage::Go,
        "rust" => CodeMapLanguage::Rust,
        "java" => CodeMapLanguage::Java,
        "c" => CodeMapLanguage::C,
        "cpp" => CodeMapLanguage::Cpp,
        "csharp" => CodeMapLanguage::CSharp,
        "php" => CodeMapLanguage::Php,
        "ruby" => CodeMapLanguage::Ruby,
        "swift" => CodeMapLanguage::Swift,
        "kotlin" => CodeMapLanguage::Kotlin,
        _ => CodeMapLanguage::TypeScript,
    }
}

fn parse_node_kind(value: &str) -> CodeMapNodeKind {
    match value {
        "file" => CodeMapNodeKind::File,
        "module" => CodeMapNodeKind::Module,
        "class" => CodeMapNodeKind::Class,
        "struct" => CodeMapNodeKind::Struct,
        "interface" => CodeMapNodeKind::Interface,
        "trait" => CodeMapNodeKind::Trait,
        "function" => CodeMapNodeKind::Function,
        "method" => CodeMapNodeKind::Method,
        "property" => CodeMapNodeKind::Property,
        "field" => CodeMapNodeKind::Field,
        "variable" => CodeMapNodeKind::Variable,
        "constant" => CodeMapNodeKind::Constant,
        "enum" => CodeMapNodeKind::Enum,
        "type_alias" => CodeMapNodeKind::TypeAlias,
        "namespace" => CodeMapNodeKind::Namespace,
        "import" => CodeMapNodeKind::Import,
        "component" => CodeMapNodeKind::Component,
        _ => CodeMapNodeKind::Function,
    }
}

fn parse_edge_kind(value: &str) -> CodeMapEdgeKind {
    match value {
        "contains" => CodeMapEdgeKind::Contains,
        "imports" => CodeMapEdgeKind::Imports,
        "exports" => CodeMapEdgeKind::Exports,
        "references" => CodeMapEdgeKind::References,
        "calls" => CodeMapEdgeKind::Calls,
        "extends" => CodeMapEdgeKind::Extends,
        "implements" => CodeMapEdgeKind::Implements,
        "type_of" => CodeMapEdgeKind::TypeOf,
        "returns" => CodeMapEdgeKind::Returns,
        "instantiates" => CodeMapEdgeKind::Instantiates,
        _ => CodeMapEdgeKind::References,
    }
}

fn parse_confidence(value: &str) -> CodeMapConfidence {
    match value {
        "exact" => CodeMapConfidence::Exact,
        "high" => CodeMapConfidence::High,
        "medium" => CodeMapConfidence::Medium,
        "low" => CodeMapConfidence::Low,
        "heuristic" => CodeMapConfidence::Heuristic,
        _ => CodeMapConfidence::Heuristic,
    }
}

fn parse_extraction_method(value: &str) -> CodeMapExtractionMethod {
    match value {
        "file_system" => CodeMapExtractionMethod::FileSystem,
        "tree_sitter" => CodeMapExtractionMethod::TreeSitter,
        "regex" => CodeMapExtractionMethod::Regex,
        "resolver" => CodeMapExtractionMethod::Resolver,
        _ => CodeMapExtractionMethod::Regex,
    }
}

fn parse_resolution_status(value: &str) -> CodeMapResolutionStatus {
    match value {
        "not_applicable" => CodeMapResolutionStatus::NotApplicable,
        "unresolved" => CodeMapResolutionStatus::Unresolved,
        "resolved" => CodeMapResolutionStatus::Resolved,
        "ambiguous" => CodeMapResolutionStatus::Ambiguous,
        _ => CodeMapResolutionStatus::Resolved,
    }
}
