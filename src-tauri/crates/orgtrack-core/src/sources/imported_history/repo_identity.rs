use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::Repository;
use rusqlite::{params, params_from_iter, Connection};

const MAX_IDENTITIES_PER_SOURCE_SYNC: usize = 8;
const GIT_REFRESH_INTERVAL_MS: i64 = 30 * 60 * 1_000;
const NOT_GIT_RETRY_INTERVAL_MS: i64 = 10 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedHistoryRepoIdentity {
    pub repo_root_path: Option<String>,
    pub remote_urls: Vec<String>,
}

#[derive(Debug)]
struct ResolvedRepoIdentity {
    repo_root_path: Option<String>,
    remote_urls: Vec<String>,
    resolution_kind: &'static str,
    refresh_interval_ms: i64,
}

/// Refresh a bounded number of repository identities referenced by one
/// imported-history source. This runs during the existing source-cache sync,
/// never while React is grouping or rendering sessions.
pub fn sync_repo_identities_for_source_from_conn(
    conn: &Connection,
    source: &str,
    now_ms: i64,
) -> Result<(), String> {
    let candidates = {
        let mut stmt = conn
            .prepare(
                "SELECT cache.repo_path
                 FROM imported_history_session_cache cache
                 LEFT JOIN imported_history_repo_identity identity
                   ON identity.working_path = cache.repo_path
                 WHERE cache.source = ?1
                   AND cache.repo_path != ''
                   AND (
                     identity.working_path IS NULL
                     OR identity.next_refresh_at_ms <= ?2
                   )
                 GROUP BY cache.repo_path
                 ORDER BY MAX(cache.updated_at_ms) DESC
                 LIMIT ?3",
            )
            .map_err(|err| format!("Failed to prepare imported repo identity query: {err}"))?;
        let rows = stmt
            .query_map(
                params![source, now_ms, MAX_IDENTITIES_PER_SOURCE_SYNC as i64],
                |row| row.get::<_, String>(0),
            )
            .map_err(|err| format!("Failed to query imported repo identity candidates: {err}"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|err| format!("Failed to read imported repo identity candidate: {err}"))?;
        rows
    };

    for working_path in candidates {
        let resolved = resolve_repo_identity(&working_path);
        let remote_urls_json = serde_json::to_string(&resolved.remote_urls)
            .map_err(|err| format!("Failed to encode imported repo remotes: {err}"))?;
        conn.execute(
            "INSERT INTO imported_history_repo_identity (
                working_path, repo_root_path, remote_urls_json,
                resolution_kind, checked_at_ms, next_refresh_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(working_path) DO UPDATE SET
                repo_root_path = excluded.repo_root_path,
                remote_urls_json = excluded.remote_urls_json,
                resolution_kind = excluded.resolution_kind,
                checked_at_ms = excluded.checked_at_ms,
                next_refresh_at_ms = excluded.next_refresh_at_ms",
            params![
                working_path,
                resolved.repo_root_path.unwrap_or_default(),
                remote_urls_json,
                resolved.resolution_kind,
                now_ms,
                now_ms.saturating_add(resolved.refresh_interval_ms),
            ],
        )
        .map_err(|err| format!("Failed to store imported repo identity: {err}"))?;
    }

    // The identity table is a bounded read model: once no imported session
    // references a path, discard its cached Git metadata.
    conn.execute(
        "DELETE FROM imported_history_repo_identity
         WHERE NOT EXISTS (
           SELECT 1
           FROM imported_history_session_cache cache
           WHERE cache.repo_path = imported_history_repo_identity.working_path
         )",
        [],
    )
    .map_err(|err| format!("Failed to prune imported repo identities: {err}"))?;
    Ok(())
}

pub fn query_repo_identities_from_conn(
    conn: &Connection,
    working_paths: &[String],
) -> Result<HashMap<String, ImportedHistoryRepoIdentity>, String> {
    if working_paths.is_empty() {
        return Ok(HashMap::new());
    }
    let placeholders = (1..=working_paths.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT working_path, repo_root_path, remote_urls_json
         FROM imported_history_repo_identity
         WHERE working_path IN ({placeholders})"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("Failed to prepare imported repo identity lookup: {err}"))?;
    let rows = stmt
        .query_map(params_from_iter(working_paths), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|err| format!("Failed to query imported repo identities: {err}"))?;

    let mut identities = HashMap::with_capacity(working_paths.len());
    for row in rows {
        let (working_path, repo_root_path, remote_urls_json) =
            row.map_err(|err| format!("Failed to read imported repo identity: {err}"))?;
        let remote_urls = serde_json::from_str::<Vec<String>>(&remote_urls_json)
            .map_err(|err| format!("Failed to decode imported repo remotes: {err}"))?;
        identities.insert(
            working_path,
            ImportedHistoryRepoIdentity {
                repo_root_path: non_empty(repo_root_path),
                remote_urls,
            },
        );
    }
    Ok(identities)
}

fn resolve_repo_identity(working_path: &str) -> ResolvedRepoIdentity {
    let Some(discovery_root) = nearest_existing_path(Path::new(working_path)) else {
        return not_git_identity();
    };
    let Ok(repository) = Repository::discover(discovery_root) else {
        return not_git_identity();
    };

    let root = repository
        .workdir()
        .unwrap_or_else(|| repository.path())
        .canonicalize()
        .unwrap_or_else(|_| {
            repository
                .workdir()
                .unwrap_or_else(|| repository.path())
                .to_path_buf()
        })
        .to_string_lossy()
        .to_string();

    let mut remote_names = repository
        .remotes()
        .ok()
        .map(|names| {
            names
                .iter()
                .flatten()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    remote_names.sort_by_key(|name| if name == "origin" { 0 } else { 1 });

    let mut remote_urls = Vec::new();
    for name in remote_names {
        let Ok(remote) = repository.find_remote(&name) else {
            continue;
        };
        let Some(url) = remote.url().or_else(|| remote.pushurl()) else {
            continue;
        };
        if !remote_urls.iter().any(|existing| existing == url) {
            remote_urls.push(url.to_string());
        }
    }

    ResolvedRepoIdentity {
        repo_root_path: non_empty(root),
        remote_urls,
        resolution_kind: "git",
        refresh_interval_ms: GIT_REFRESH_INTERVAL_MS,
    }
}

fn nearest_existing_path(path: &Path) -> Option<PathBuf> {
    let mut candidate = path.to_path_buf();
    loop {
        if candidate.exists() {
            return if candidate.is_file() {
                candidate.parent().map(Path::to_path_buf)
            } else {
                Some(candidate)
            };
        }
        if !candidate.pop() {
            return None;
        }
    }
}

fn not_git_identity() -> ResolvedRepoIdentity {
    ResolvedRepoIdentity {
        repo_root_path: None,
        remote_urls: Vec::new(),
        resolution_kind: "not_git",
        refresh_interval_ms: NOT_GIT_RETRY_INTERVAL_MS,
    }
}

fn non_empty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(label: &str) -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "orgii-imported-repo-identity-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn discovers_repo_from_nested_and_missing_historical_paths() {
        let root = unique_test_dir("discover");
        std::fs::create_dir_all(root.join(".claude/worktrees")).expect("test dirs");
        let repo = Repository::init(&root).expect("init repo");
        repo.remote("upstream", "git@github.com:yorgai/org2.git")
            .expect("upstream");
        repo.remote("origin", "https://github.com/me/org2.git")
            .expect("origin");

        let resolved = resolve_repo_identity(
            root.join(".claude/worktrees/deleted-agent")
                .to_string_lossy()
                .as_ref(),
        );

        let canonical_root = root
            .canonicalize()
            .expect("canonical root")
            .to_string_lossy()
            .to_string();
        assert_eq!(resolved.repo_root_path.as_deref(), Some(&*canonical_root));
        assert_eq!(
            resolved.remote_urls,
            vec![
                "https://github.com/me/org2.git".to_string(),
                "git@github.com:yorgai/org2.git".to_string()
            ]
        );
        std::fs::remove_dir_all(&root).expect("remove test repo");
    }

    #[test]
    fn caches_plain_folders_as_not_git() {
        let root = unique_test_dir("plain");
        std::fs::create_dir_all(&root).expect("test dir");
        let resolved = resolve_repo_identity(root.to_string_lossy().as_ref());
        assert_eq!(resolved.resolution_kind, "not_git");
        assert_eq!(resolved.repo_root_path, None);
        assert!(resolved.remote_urls.is_empty());
        std::fs::remove_dir_all(&root).expect("remove test dir");
    }

    #[test]
    fn source_sync_resolves_at_most_the_per_pass_cap() {
        let conn = Connection::open_in_memory().expect("in-memory db");
        crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init tables");
        crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("init source cache tables");
        for index in 0..40 {
            conn.execute(
                "INSERT INTO imported_history_session_cache (
                    source, source_session_id, session_id, repo_path
                 ) VALUES ('codex_app', ?1, ?2, ?3)",
                params![
                    format!("source-{index}"),
                    format!("session-{index}"),
                    format!("/definitely-missing/orgii-repo-{index}")
                ],
            )
            .expect("insert cache row");
        }

        sync_repo_identities_for_source_from_conn(&conn, "codex_app", 1_000)
            .expect("sync identities");

        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM imported_history_repo_identity",
                [],
                |row| row.get(0),
            )
            .expect("identity count");
        assert_eq!(count, MAX_IDENTITIES_PER_SOURCE_SYNC as i64);
    }
}
