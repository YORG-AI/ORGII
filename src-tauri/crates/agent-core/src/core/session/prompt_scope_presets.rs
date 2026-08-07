//! Explicitly scoped prompt and memory presets.
//!
//! Presets are durable instructions or knowledge pointers, never inferred from
//! a session title, path, or timestamp.  Runtime projection is intentionally
//! narrow: user -> workspace -> project, with exact stable IDs at every level.

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PromptPresetScope {
    User,
    Workspace {
        workspace_id: String,
    },
    Project {
        workspace_id: String,
        project_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegisterPromptPresetRequest {
    pub preset_id: String,
    pub scope: PromptPresetScope,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPreset {
    pub id: String,
    pub scope: PromptPresetScope,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptPresetError {
    Validation(String),
    Storage(String),
}

impl fmt::Display for PromptPresetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) | Self::Storage(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for PromptPresetError {}

pub type PromptPresetResult<T> = Result<T, PromptPresetError>;

const PRESETS_DDL: &str = r#"
    CREATE TABLE IF NOT EXISTS session_journey_metadata (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        topic_tags_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS prompt_scope_presets (
        preset_id TEXT PRIMARY KEY,
        scope_kind TEXT NOT NULL CHECK (scope_kind IN ('user', 'workspace', 'project')),
        workspace_id TEXT,
        project_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (
            (scope_kind = 'user' AND workspace_id IS NULL AND project_id IS NULL) OR
            (scope_kind = 'workspace' AND workspace_id IS NOT NULL AND project_id IS NULL) OR
            (scope_kind = 'project' AND workspace_id IS NOT NULL AND project_id IS NOT NULL)
        )
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_scope_presets_projection
        ON prompt_scope_presets(scope_kind, workspace_id, project_id, preset_id);
"#;

pub fn ensure_prompt_scope_preset_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(PRESETS_DDL)
}

/// Persist a request with explicit, typed stable IDs.  This low-level API is
/// useful to a settings surface that has already resolved its target.
pub fn register_prompt_preset(
    conn: &Connection,
    request: &RegisterPromptPresetRequest,
) -> PromptPresetResult<()> {
    ensure_prompt_scope_preset_schema(conn)
        .map_err(|_| PromptPresetError::Storage("无法初始化预设存储。".into()))?;
    validate_request(request)?;
    let (scope_kind, workspace_id, project_id) = scope_columns(&request.scope);
    let inserted = conn
        .execute(
            "INSERT OR IGNORE INTO prompt_scope_presets
             (preset_id, scope_kind, workspace_id, project_id, content)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                request.preset_id,
                scope_kind,
                workspace_id,
                project_id,
                request.content
            ],
        )
        .map_err(|_| PromptPresetError::Storage("无法保存预设。".into()))?;
    if inserted == 0 {
        let existing = load_preset(conn, &request.preset_id)?;
        if existing.as_ref() == Some(&request_to_preset(request)) {
            return Ok(());
        }
        return Err(PromptPresetError::Validation(format!(
            "预设 ID 已注册且内容或作用域不一致：{}。",
            request.preset_id
        )));
    }
    Ok(())
}

/// Register from a session only after its durable coordinates prove that the
/// requested workspace/project target is the current session's target.
pub fn register_prompt_preset_for_session(
    conn: &Connection,
    session_id: &str,
    request: &RegisterPromptPresetRequest,
) -> PromptPresetResult<()> {
    let target = resolve_session_target(conn, session_id)?;
    match &request.scope {
        PromptPresetScope::User => {}
        PromptPresetScope::Workspace { .. } if target.workspace_id.is_none() => {
            return Err(PromptPresetError::Validation(
                "当前会话没有显式工作区 ID，无法注册工作区预设。".into(),
            ));
        }
        PromptPresetScope::Workspace { workspace_id }
            if target.workspace_id.as_deref() == Some(workspace_id) => {}
        PromptPresetScope::Project { .. }
            if target.workspace_id.is_none() || target.project_id.is_none() =>
        {
            return Err(PromptPresetError::Validation(
                "当前会话缺少显式工作区 ID 或项目 ID，无法注册项目预设。".into(),
            ));
        }
        PromptPresetScope::Project {
            workspace_id,
            project_id,
        } if target.workspace_id.as_deref() == Some(workspace_id)
            && target.project_id.as_deref() == Some(project_id) => {}
        PromptPresetScope::Workspace { .. } => {
            return Err(PromptPresetError::Validation(
                "预设工作区目标与当前会话的显式工作区不匹配。".into(),
            ));
        }
        PromptPresetScope::Project { .. } => {
            return Err(PromptPresetError::Validation(
                "预设项目目标与当前会话的显式工作区或项目不匹配。".into(),
            ));
        }
    }
    register_prompt_preset(conn, request)
}

/// Resolve the stable presets visible to a session.  The SQL predicate is
/// deliberately exact, so sibling-project rows can never enter the result.
pub fn resolve_prompt_presets_for_session(
    conn: &Connection,
    session_id: &str,
) -> PromptPresetResult<Vec<PromptPreset>> {
    ensure_prompt_scope_preset_schema(conn)
        .map_err(|_| PromptPresetError::Storage("无法初始化预设存储。".into()))?;
    let target = resolve_session_target(conn, session_id)?;
    let mut statement = conn
        .prepare(
            "SELECT preset_id, scope_kind, workspace_id, project_id, content
             FROM prompt_scope_presets
             WHERE scope_kind = 'user'
                OR (scope_kind = 'workspace' AND workspace_id = ?1)
                OR (scope_kind = 'project' AND workspace_id = ?1 AND project_id = ?2)
             ORDER BY CASE scope_kind WHEN 'user' THEN 0 WHEN 'workspace' THEN 1 ELSE 2 END,
                      preset_id",
        )
        .map_err(|_| PromptPresetError::Storage("无法读取预设。".into()))?;
    let presets = statement
        .query_map(
            params![target.workspace_id, target.project_id],
            row_to_preset,
        )
        .map_err(|_| PromptPresetError::Storage("无法读取预设。".into()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PromptPresetError::Storage("预设记录格式无效。".into()))?;
    Ok(presets)
}

/// Prompt renderer boundary.  No contents are logged; a registration is a
/// knowledge pointer and must not turn secret values into telemetry.
pub fn project_prompt_presets_for_session(conn: &Connection, session_id: &str) -> String {
    match resolve_prompt_presets_for_session(conn, session_id) {
        Ok(presets) if !presets.is_empty() => presets
            .into_iter()
            .map(|preset| preset.content)
            .collect::<Vec<_>>()
            .join("\n\n"),
        Ok(_) | Err(_) => String::new(),
    }
}

#[derive(Debug)]
struct SessionTarget {
    workspace_id: Option<String>,
    project_id: Option<String>,
}

fn resolve_session_target(
    conn: &Connection,
    session_id: &str,
) -> PromptPresetResult<SessionTarget> {
    if session_id.trim().is_empty() {
        return Err(PromptPresetError::Validation("会话 ID 不能为空。".into()));
    }
    conn.query_row(
        "SELECT metadata.workspace_id, sessions.project_id
         FROM agent_sessions AS sessions
         LEFT JOIN session_journey_metadata AS metadata ON metadata.session_id = sessions.session_id
         WHERE sessions.session_id = ?1",
        [session_id],
        |row| {
            Ok(SessionTarget {
                workspace_id: row.get(0)?,
                project_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|_| PromptPresetError::Storage("无法解析会话的工作区和项目。".into()))?
    .ok_or_else(|| PromptPresetError::Validation(format!("未知会话：{session_id}。")))
}

fn validate_request(request: &RegisterPromptPresetRequest) -> PromptPresetResult<()> {
    if request.preset_id.trim().is_empty() {
        return Err(PromptPresetError::Validation("预设 ID 不能为空。".into()));
    }
    if request.content.trim().is_empty() {
        return Err(PromptPresetError::Validation("预设内容不能为空。".into()));
    }
    match &request.scope {
        PromptPresetScope::User => Ok(()),
        PromptPresetScope::Workspace { workspace_id } if workspace_id.trim().is_empty() => Err(
            PromptPresetError::Validation("工作区预设必须提供稳定的工作区 ID。".into()),
        ),
        PromptPresetScope::Project {
            workspace_id,
            project_id,
        } if workspace_id.trim().is_empty() || project_id.trim().is_empty() => Err(
            PromptPresetError::Validation("项目预设必须提供稳定的工作区 ID 和项目 ID。".into()),
        ),
        _ => Ok(()),
    }
}

fn scope_columns(scope: &PromptPresetScope) -> (&'static str, Option<&str>, Option<&str>) {
    match scope {
        PromptPresetScope::User => ("user", None, None),
        PromptPresetScope::Workspace { workspace_id } => ("workspace", Some(workspace_id), None),
        PromptPresetScope::Project {
            workspace_id,
            project_id,
        } => ("project", Some(workspace_id), Some(project_id)),
    }
}

fn request_to_preset(request: &RegisterPromptPresetRequest) -> PromptPreset {
    PromptPreset {
        id: request.preset_id.clone(),
        scope: request.scope.clone(),
        content: request.content.clone(),
    }
}

fn load_preset(conn: &Connection, preset_id: &str) -> PromptPresetResult<Option<PromptPreset>> {
    conn.query_row(
        "SELECT preset_id, scope_kind, workspace_id, project_id, content FROM prompt_scope_presets WHERE preset_id = ?1",
        [preset_id],
        row_to_preset,
    )
    .optional()
    .map_err(|_| PromptPresetError::Storage("无法读取已有预设。".into()))
}

fn row_to_preset(row: &rusqlite::Row<'_>) -> rusqlite::Result<PromptPreset> {
    let kind: String = row.get(1)?;
    let workspace_id: Option<String> = row.get(2)?;
    let project_id: Option<String> = row.get(3)?;
    let scope = match (kind.as_str(), workspace_id, project_id) {
        ("user", None, None) => PromptPresetScope::User,
        ("workspace", Some(workspace_id), None) => PromptPresetScope::Workspace { workspace_id },
        ("project", Some(workspace_id), Some(project_id)) => PromptPresetScope::Project {
            workspace_id,
            project_id,
        },
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(PromptPreset {
        id: row.get(0)?,
        scope,
        content: row.get(4)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY, project_id TEXT);
                            CREATE TABLE session_journey_metadata (session_id TEXT PRIMARY KEY, workspace_id TEXT);").unwrap();
        for (id, workspace, project) in [
            ("a", "ws-1", "project-a"),
            ("b", "ws-1", "project-b"),
            ("other", "ws-2", "project-c"),
        ] {
            conn.execute(
                "INSERT INTO agent_sessions VALUES (?1, ?2)",
                params![id, project],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session_journey_metadata VALUES (?1, ?2)",
                params![id, workspace],
            )
            .unwrap();
        }
        conn
    }

    fn request(id: &str, scope: PromptPresetScope, content: &str) -> RegisterPromptPresetRequest {
        RegisterPromptPresetRequest {
            preset_id: id.into(),
            scope,
            content: content.into(),
        }
    }

    #[test]
    fn strict_inheritance_is_stable_and_never_leaks_to_siblings() {
        let conn = conn();
        register_prompt_preset_for_session(
            &conn,
            "a",
            &request("u", PromptPresetScope::User, "用户预设"),
        )
        .unwrap();
        register_prompt_preset_for_session(
            &conn,
            "a",
            &request(
                "w",
                PromptPresetScope::Workspace {
                    workspace_id: "ws-1".into(),
                },
                "工作区预设",
            ),
        )
        .unwrap();
        register_prompt_preset_for_session(
            &conn,
            "a",
            &request(
                "a",
                PromptPresetScope::Project {
                    workspace_id: "ws-1".into(),
                    project_id: "project-a".into(),
                },
                "A 项目预设",
            ),
        )
        .unwrap();

        let projected = |session| {
            resolve_prompt_presets_for_session(&conn, session)
                .unwrap()
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(projected("a"), vec!["u", "w", "a"]);
        assert_eq!(projected("b"), vec!["u", "w"]);
        assert_eq!(projected("other"), vec!["u"]);
        assert_eq!(projected("a"), vec!["u", "w", "a"]);
    }

    #[test]
    fn registration_requires_exact_targets_and_is_idempotent() {
        let conn = conn();
        let missing = request(
            "bad",
            PromptPresetScope::Workspace {
                workspace_id: " ".into(),
            },
            "x",
        );
        assert_eq!(
            register_prompt_preset(&conn, &missing)
                .unwrap_err()
                .to_string(),
            "工作区预设必须提供稳定的工作区 ID。"
        );
        let wrong = request(
            "bad",
            PromptPresetScope::Project {
                workspace_id: "ws-1".into(),
                project_id: "project-b".into(),
            },
            "x",
        );
        assert_eq!(
            register_prompt_preset_for_session(&conn, "a", &wrong)
                .unwrap_err()
                .to_string(),
            "预设项目目标与当前会话的显式工作区或项目不匹配。"
        );
        assert_eq!(
            resolve_prompt_presets_for_session(&conn, "missing")
                .unwrap_err()
                .to_string(),
            "未知会话：missing。"
        );
        conn.execute(
            "INSERT INTO agent_sessions VALUES ('unbound', 'project-a')",
            [],
        )
        .unwrap();
        let unbound = request(
            "unbound",
            PromptPresetScope::Workspace {
                workspace_id: "ws-1".into(),
            },
            "x",
        );
        assert_eq!(
            register_prompt_preset_for_session(&conn, "unbound", &unbound)
                .unwrap_err()
                .to_string(),
            "当前会话没有显式工作区 ID，无法注册工作区预设。"
        );

        let same = request("once", PromptPresetScope::User, "只投影一次");
        register_prompt_preset_for_session(&conn, "a", &same).unwrap();
        register_prompt_preset_for_session(&conn, "a", &same).unwrap();
        assert_eq!(project_prompt_presets_for_session(&conn, "a"), "只投影一次");
    }
}
