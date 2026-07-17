//! `UnifiedSessionRecord` + the `session_type` constant tier.
//!
//! Pure data: the in-memory representation of one row of `agent_sessions`,
//! plus the canonical strings stored in the `session_type` column.

use serde::{Deserialize, Serialize};

use core_types::key_source::KeySource;

/// Valid values for [`UnifiedSessionRecord::session_type`].
///
/// Stored in the `agent_sessions.session_type` column and used to route
/// sessions to the right listing / filtering code paths.
pub mod session_type {
    /// Channel-originated (desktop) session — Telegram, Discord, email, …
    pub const DESKTOP: &str = "os";
    /// Coding session (the legacy "SDE" label is kept for database stability).
    pub const CODING: &str = "sde";
    /// Generic fallback — used as the SQL column default and when an existing
    /// row is missing a type.
    pub const GENERIC: &str = "agent";
    /// Child session spawned by a parent agent via the `agent` tool.
    pub const SUBAGENT: &str = "subagent";
    /// Materialized member session that belongs to an Agent Org run roster.
    pub const ORG_MEMBER: &str = "agent_org_member";
    /// Gateway router singleton — infrastructure session that dispatches
    /// inbound channel messages to OS/SDE downstream agents. Never exposed
    /// in the frontend session list (filtered out by `list_sessions`).
    pub const GATEWAY: &str = "gateway";
}

/// Database record for a unified session.
///
/// This struct maps directly to the `agent_sessions` table columns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedSessionRecord {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub model: Option<String>,
    pub account_id: Option<String>,
    /// Provider override for Rust Agent sessions using a native subscription harness.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_harness_type: Option<String>,
    pub user_input: Option<String>,
    #[serde(default)]
    pub total_tokens: i64,
    pub created_at: String,
    pub updated_at: String,

    pub session_type: String,
    pub channel: Option<String>,
    pub chat_id: Option<String>,

    /// Storage projection of `SessionWorkspace.workspace_root` — the
    /// stable, user-visible identity for the session's project
    /// (e.g. `/home/alice/myproj`). NOT the agent's cwd: file tools
    /// execute against `working_dir` (see `worktree_path` and
    /// `workspace::load_workspace`). For non-worktree sessions
    /// the two paths are equal; for worktree sessions they differ.
    /// `None` only for pure-channel OS sessions with no project
    /// grounding (e.g. some gateway entry points).
    pub workspace_path: Option<String>,
    pub org_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub work_item_id: Option<String>,
    pub agent_role: Option<String>,
    /// Storage projection of `SessionWorkspace.working_dir` — the
    /// agent's actual cwd. Stored ONLY when the session is a
    /// worktree session (i.e. `working_dir != workspace_root`);
    /// non-worktree sessions store `NULL` here so the existing
    /// `worktree_path.is_some()` "is worktree?" predicate keeps
    /// working. `load_workspace` collapses NULL onto `workspace_path`
    /// when reconstructing `SessionWorkspace.working_dir`.
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub base_branch: Option<String>,
    pub merge_status: Option<String>,
    pub project_slug: Option<String>,
    pub agent_definition_id: Option<String>,
    /// Agent Org roster member id for `session_type::ORG_MEMBER` rows.
    /// This identifies the member instance, while `agent_definition_id`
    /// identifies which AgentDefinition that member runs.
    pub org_member_id: Option<String>,

    pub parent_session_id: Option<String>,
    pub parent_event_id: Option<String>,

    /// — JSON-encoded `BTreeMap<PathBuf, AdditionalDirectory>`.
    /// Always a well-formed JSON object; empty-map default is `"{}"`.
    /// Read/written through `load_workspace` / `save_workspace`.
    #[serde(default = "default_workspace_additional_json")]
    pub workspace_additional_json: String,

    /// Where credentials come from for this session: `OwnKey` (BYOK) or
    /// `HostedKey` (hosted proxy). Mirrors `code_sessions.key_source` on
    /// the CLI side. Persisted in the `key_source` column with a column
    /// default of `'own_key'` and rejected at the row mapper if the stored
    /// value isn't a known `KeySource` variant — the same fail-closed
    /// posture the CLI path uses, because routing a corrupt value to
    /// `OwnKey` would mis-bill market sessions (and vice versa).
    #[serde(default)]
    pub key_source: KeySource,

    /// Per-session execution mode picked by the user via the in-session
    /// `ModePill` (build / ask / plan / debug / review / wingman).
    ///
    /// `None` means the user has never patched this session — the frontend
    /// falls back to the global `creatorDefaultExecModeAtom` until the
    /// first `session_patch` lands a concrete value. This is the
    /// authoritative source of truth: the in-session ModePill reads from
    /// here, every dispatch (including queue replay and follow-ups) reads
    /// from here, so switching sessions or restarting the app preserves
    /// per-session mode.
    ///
    /// Only `agent_sessions` writes this column; CLI sessions never have
    /// a mode (their column would be a stable `None`, which is why
    /// `code_sessions` doesn't carry the field at all).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_exec_mode: Option<String>,

    /// Per-session unsent draft text (P3). Whatever is currently sitting
    /// in the chat composer for this session, persisted across navigation
    /// and app restarts. Cleared on send. Mirrored on `code_sessions`
    /// for CLI parity. `None` means "no draft" (the default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft_text: Option<String>,

    /// Per-session reply target — the `agent_messages` / chunk id the
    /// user has currently pinned via the chat item's "Reply" action
    /// (P3). `None` means no reply banner is open. Cleared when the
    /// banner is dismissed or the message is sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_target_event_id: Option<String>,
    /// Whether the session is pinned to the top of the sidebar.
    /// Stored as INTEGER (0/1) in the `pinned` column.
    #[serde(default)]
    pub pinned: bool,
}

/// Default for [`UnifiedSessionRecord::workspace_additional_json`]: the
/// empty JSON object `{}`. Matches the DB column default and keeps
/// round-trip upserts faithful for callers that don't touch the field.
pub(super) fn default_workspace_additional_json() -> String {
    "{}".to_string()
}

impl Default for UnifiedSessionRecord {
    fn default() -> Self {
        Self {
            session_id: String::new(),
            name: String::new(),
            status: String::new(),
            model: None,
            account_id: None,
            native_harness_type: None,
            user_input: None,
            total_tokens: 0,
            created_at: String::new(),
            updated_at: String::new(),
            session_type: String::new(),
            channel: None,
            chat_id: None,
            workspace_path: None,
            org_id: None,
            project_id: None,
            project_name: None,
            work_item_id: None,
            agent_role: None,
            worktree_path: None,
            worktree_branch: None,
            base_branch: None,
            merge_status: None,
            project_slug: None,
            agent_definition_id: None,
            org_member_id: None,
            parent_session_id: None,
            parent_event_id: None,
            workspace_additional_json: default_workspace_additional_json(),
            key_source: KeySource::default(),
            agent_exec_mode: None,
            draft_text: None,
            reply_target_event_id: None,
            pinned: false,
        }
    }
}

/// Single source of truth for the column list returned by every
/// `UnifiedSessionRecord` SELECT query. Joined with a `WHERE …` /
/// `ORDER BY …` suffix at each call site.
///
/// `COALESCE(s.key_source, 'own_key')` mirrors the CLI-side
/// `code_sessions` SELECT: defends against rows written by older builds
/// (or hand-edited ones) where the column might still be NULL despite
/// the `NOT NULL DEFAULT 'own_key'` schema. The row mapper then runs
/// `KeySource::parse` on the resulting string and rejects any unknown
/// value — fail-closed, same posture as the CLI side.
pub(super) const UNIFIED_SESSION_SELECT: &str = r#"
    SELECT
        s.session_id, s.name, s.status, s.model, s.account_id, s.user_input,
        COALESCE((SELECT total_tokens FROM orgtrack_core_session_usage WHERE session_id = s.session_id), 0),
        s.created_at, s.updated_at, s.session_type, s.channel, s.chat_id,
        s.workspace_path, s.org_id, s.project_id, s.project_name,
        s.work_item_id, s.agent_role, s.worktree_path,
        s.worktree_branch, s.base_branch, s.merge_status,
        s.project_slug, s.agent_definition_id, s.org_member_id,
        s.parent_session_id, s.parent_event_id,
        s.workspace_additional_json,
        COALESCE(s.key_source, 'own_key'),
        s.agent_exec_mode,
        s.native_harness_type,
        s.draft_text,
        s.reply_target_event_id,
        COALESCE(s.pinned, 0)
    FROM agent_sessions s
"#;

/// Row mapper for unified session records. Must be kept in lock-step with
/// [`UNIFIED_SESSION_SELECT`].
pub(super) fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<UnifiedSessionRecord> {
    let key_source_str: String = row.get(28)?;
    // Fail-closed on unknown `key_source` values rather than silently
    // mapping to `OwnKey`: a bad value here means the row was written by
    // a build that doesn't agree with us about the enum, and treating it
    // as `OwnKey` would mis-bill any market session that happened to be
    // affected. Same reasoning the CLI `row_to_session` uses.
    let key_source = KeySource::parse(&key_source_str).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            28,
            rusqlite::types::Type::Text,
            format!("unknown KeySource value: {key_source_str:?}").into(),
        )
    })?;
    Ok(UnifiedSessionRecord {
        session_id: row.get(0)?,
        name: row.get(1)?,
        status: row.get(2)?,
        model: row.get(3)?,
        account_id: row.get(4)?,
        native_harness_type: row.get(30)?,
        user_input: row.get(5)?,
        total_tokens: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        session_type: row.get(9)?,
        channel: row.get(10)?,
        chat_id: row.get(11)?,
        workspace_path: row.get(12)?,
        org_id: row.get(13)?,
        project_id: row.get(14)?,
        project_name: row.get(15)?,
        work_item_id: row.get(16)?,
        agent_role: row.get(17)?,
        worktree_path: row.get(18)?,
        worktree_branch: row.get(19)?,
        base_branch: row.get(20)?,
        merge_status: row.get(21)?,
        project_slug: row.get(22)?,
        agent_definition_id: row.get(23)?,
        org_member_id: row.get(24)?,
        parent_session_id: row.get(25)?,
        parent_event_id: row.get(26)?,
        workspace_additional_json: row.get(27)?,
        key_source,
        agent_exec_mode: row.get(29)?,
        draft_text: row.get(31)?,
        reply_target_event_id: row.get(32)?,
        pinned: {
            let pinned_int: i64 = row.get(33)?;
            pinned_int != 0
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Column layout MUST mirror `UNIFIED_SESSION_SELECT` (34 columns) —
    // these fixtures drift silently when production columns are added.
    const VALID_ROW_SELECT: &str = r#"
        SELECT
            'sid', 'name', 'running', 'model', 'acct', NULL,
            0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'sde',
            NULL, NULL, '/tmp/project', NULL, NULL, NULL,
            NULL, NULL, NULL,
            NULL, NULL, NULL,
            NULL, 'builtin:sde', NULL,
            NULL, NULL,
            '{}',
            'own_key',
            NULL,
            NULL,
            NULL,
            NULL,
            0
    "#;

    #[test]
    fn row_to_record_reads_valid_row() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let record = conn.query_row(VALID_ROW_SELECT, [], row_to_record).unwrap();

        assert_eq!(record.session_id, "sid");
        assert_eq!(record.session_type, "sde");
        assert_eq!(record.workspace_path.as_deref(), Some("/tmp/project"));
        assert_eq!(record.agent_definition_id.as_deref(), Some("builtin:sde"));
        assert_eq!(record.workspace_additional_json, "{}");
        assert_eq!(record.key_source, KeySource::OwnKey);
    }

    #[test]
    fn row_to_record_reads_hosted_key() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let record = conn
            .query_row(
                r#"
                SELECT
                    'sid', 'name', 'running', 'model', 'acct', NULL,
                    0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'sde',
                    NULL, NULL, '/tmp/project', NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, 'builtin:sde', NULL,
                    NULL, NULL,
                    '{}',
                    'hosted_key',
                    'plan',
                    NULL,
                    'half-typed reply',
                    'evt-42',
                    0
                "#,
                [],
                row_to_record,
            )
            .unwrap();
        assert_eq!(record.key_source, KeySource::HostedKey);
        assert_eq!(record.agent_exec_mode.as_deref(), Some("plan"));
        assert_eq!(record.draft_text.as_deref(), Some("half-typed reply"));
        assert_eq!(record.reply_target_event_id.as_deref(), Some("evt-42"));
    }

    #[test]
    fn row_to_record_reads_null_draft_and_reply_as_none() {
        // Both columns default to NULL — meaning "no unsent draft" and
        // "no reply banner pinned" respectively. The mapper must surface
        // these as `None` rather than `Some("")`, otherwise the
        // composer would render an empty banner / re-hydrate an empty
        // draft and overwrite whatever the editor currently holds.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let record = conn.query_row(VALID_ROW_SELECT, [], row_to_record).unwrap();
        assert!(record.draft_text.is_none());
        assert!(record.reply_target_event_id.is_none());
    }

    #[test]
    fn row_to_record_reads_null_agent_exec_mode_as_none() {
        // The default for the column is NULL — represents "user has never
        // patched this session, fall back to the global creator default
        // on the frontend". The mapper must not coerce NULL into a
        // wildcard string here.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let record = conn.query_row(VALID_ROW_SELECT, [], row_to_record).unwrap();
        assert!(record.agent_exec_mode.is_none());
    }

    #[test]
    fn row_to_record_rejects_unknown_key_source() {
        // Regression: the previous mapper had no `key_source` column at
        // all, so corrupt values would have been silently invisible. The
        // typed mapper must fail-closed on typos / unknown variants the
        // same way `cli/persistence::row_to_session` does, otherwise a
        // garbage value billed as `own_key` would mis-attribute a market
        // session.
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let err = conn
            .query_row(
                r#"
                SELECT
                    'sid', 'name', 'running', 'model', 'acct', NULL,
                    0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'sde',
                    NULL, NULL, '/tmp/project', NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, 'builtin:sde', NULL,
                    NULL, NULL,
                    '{}',
                    'market',
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    0
                "#,
                [],
                row_to_record,
            )
            .expect_err("unknown KeySource must surface as a conversion failure");

        assert!(matches!(
            err,
            rusqlite::Error::FromSqlConversionFailure(_, _, _)
        ));
    }

    #[test]
    fn row_to_record_propagates_optional_column_type_errors() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let err = conn
            .query_row(
                r#"
                SELECT
                    'sid', 'name', 'running', 'model', 'acct', NULL,
                    0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'sde',
                    NULL, NULL, zeroblob(1), NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, NULL, NULL,
                    NULL, 'builtin:sde', NULL,
                    NULL, NULL,
                    '{}',
                    'own_key',
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    0
                "#,
                [],
                row_to_record,
            )
            .expect_err("invalid optional column type must surface");

        assert!(matches!(err, rusqlite::Error::InvalidColumnType(_, _, _)));
    }

    #[test]
    fn row_to_record_propagates_workspace_json_type_errors() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let err = conn
            .query_row(
                r#"
                SELECT
                    'sid', 'name', 'running', 'model', 'acct', NULL,
                    0, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', 'sde',
                    NULL, NULL, '/tmp/project', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                    'builtin:sde', NULL, NULL, NULL, NULL, 'own_key', NULL, NULL, NULL, NULL,
                    0
                "#,
                [],
                row_to_record,
            )
            .expect_err("workspace JSON must be present and typed");

        assert!(matches!(err, rusqlite::Error::InvalidColumnType(_, _, _)));
    }
}
