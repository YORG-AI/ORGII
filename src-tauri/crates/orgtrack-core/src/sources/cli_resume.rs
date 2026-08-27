//! Native-CLI resume planning for imported external sessions.
//!
//! An imported transcript is read-only inside ORGII, but the CLI that wrote
//! it can usually reopen the very same conversation (`claude --resume`,
//! `codex resume`, `cursor-agent --resume`, `opencode --session`, …). This
//! module owns the mapping from an imported-history cache row to that
//! invocation, so the desktop app (chat-panel TUI terminal) and the
//! `orgtrack` CLI agree on which sources are resumable and how the command
//! line is spelled.
//!
//! Only sources whose CLI has a session resume entry point verified against
//! the real binary (or an unambiguous fork of one) belong here. Deliberately
//! absent:
//! - `cursor_ide` — IDE composers live in `state.vscdb` and share no id
//!   space with `cursor-agent`'s `~/.cursor/chats` store (verified
//!   empirically: zero overlap), so no CLI can reopen them.
//! - `windsurf`, `warp`, `trae`, `qoder` — app/IDE-bound conversation
//!   stores with no CLI resume surface at all.
//! - `zcode`, `qoder_cli`, `workbuddy` — their CLIs likely resume
//!   (OpenCode fork / documented `/resume` / Claude Code fork), but no
//!   binary was available to verify the exact flag shape; extend here once
//!   one is.

use rusqlite::Connection;
use serde::Serialize;

use super::imported_history::cache::{
    query_cached_session_by_session_id_from_conn, ImportedHistoryCachedSession,
};
use super::imported_history::metadata::{
    SOURCE_CLAUDE_CODE, SOURCE_CLINE, SOURCE_CODEX_APP, SOURCE_COPILOT, SOURCE_CURSOR_CLI,
    SOURCE_KIMI, SOURCE_MIMO_CODE, SOURCE_OMP, SOURCE_OPENCODE,
};

/// How to hand an imported external session back to the CLI that owns it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResumePlan {
    /// Imported-history source id the plan derives from.
    pub source: &'static str,
    /// `code_sessions.cli_agent_type` value of the owning CLI, so hosts can
    /// reuse managed-session infrastructure (launch profiles, TUI rows,
    /// managed-mirror dedup) unchanged.
    pub cli_agent_type: &'static str,
    /// Bare binary to launch when no launch-profile override applies.
    pub default_binary: &'static str,
    /// Arguments appended after the binary to reopen the session.
    pub resume_args: Vec<String>,
    /// The session id the CLI itself accepts (bare thread uuid / chat id).
    pub native_session_id: String,
    /// Working directory the resume should run in — the session's recorded
    /// workspace. `None` when the source never recorded one.
    pub cwd: Option<String>,
    /// Whether the CLI can only locate the session from its original
    /// working directory (Claude Code keys session storage on the project
    /// path; Codex and cursor-agent look sessions up globally).
    pub requires_cwd: bool,
}

impl CliResumePlan {
    /// The full resume invocation as one display string, shell-quoted for
    /// the host's default chat-panel PTY shell — PowerShell on Windows
    /// (`terminal::pty_commands::shells` makes it the Windows default),
    /// POSIX elsewhere.
    pub fn display_command(&self) -> String {
        self.display_command_for_shell(cfg!(windows))
    }

    /// `display_command`, with the target shell pinned explicitly instead
    /// of read from the host OS, so both quoting styles can be exercised
    /// without `#[cfg(windows)]`-gating the test itself.
    pub fn display_command_for_shell(&self, windows: bool) -> String {
        std::iter::once(self.default_binary.to_string())
            .chain(self.resume_args.iter().cloned())
            .map(|part| shell_quote_for_shell(&part, windows))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Shell-quote for the host's default chat-panel PTY shell (PowerShell on
/// Windows, POSIX elsewhere). Safe-charset values pass through unquoted so
/// the common `claude --resume <uuid>` stays copy-paste clean.
pub fn shell_quote(value: &str) -> String {
    shell_quote_for_shell(value, cfg!(windows))
}

/// `shell_quote`, with the target shell pinned explicitly instead of read
/// from the host OS (see `display_command_for_shell`).
pub fn shell_quote_for_shell(value: &str, windows: bool) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_./:@%+=,-".contains(&byte))
    {
        return value.to_string();
    }
    if windows {
        // PowerShell single-quoted strings pass backslashes through
        // literally (unlike POSIX), so a Windows path only needs its
        // embedded single quotes escaped, by doubling them.
        format!("'{}'", value.replace('\'', "''"))
    } else {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}

/// Build the resume plan for one imported session, or `None` when the
/// source has no CLI resume path (or the id shape rules it out).
/// `source_path` is the imported transcript/store path; only path-addressed
/// CLIs (oh-my-pi's `--session <path>`) consume it.
pub fn cli_resume_plan(
    source: &str,
    source_session_id: &str,
    repo_path: Option<&str>,
    source_path: Option<&str>,
) -> Option<CliResumePlan> {
    let cwd = repo_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    match source {
        // Claude Code sessions are `<uuid>.jsonl` under the project slug;
        // the file stem IS the id `--resume` accepts. Non-uuid stems
        // (fixtures, sidecars) are not resumable.
        SOURCE_CLAUDE_CODE => {
            if !is_uuid_like(source_session_id) {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_CLAUDE_CODE,
                cli_agent_type: "claude_code",
                default_binary: "claude",
                resume_args: vec!["--resume".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: true,
            })
        }
        // Codex imports key on the rollout file stem
        // (`rollout-<timestamp>-<thread-uuid>`), while `codex resume` takes
        // the bare thread uuid — same suffix extraction the managed-mirror
        // dedup uses.
        SOURCE_CODEX_APP => {
            let thread_uuid = codex_thread_uuid_from_stem(source_session_id)?;
            Some(CliResumePlan {
                source: SOURCE_CODEX_APP,
                cli_agent_type: "codex",
                default_binary: "codex",
                resume_args: vec!["resume".to_string(), thread_uuid.to_string()],
                native_session_id: thread_uuid.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // cursor-agent stores one `store.db` per chat uuid; `--resume <id>`
        // reopens it from anywhere.
        SOURCE_CURSOR_CLI => {
            if !is_uuid_like(source_session_id) {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_CURSOR_CLI,
                cli_agent_type: "cursor_cli",
                default_binary: "cursor-agent",
                resume_args: vec!["--resume".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // OpenCode keeps every session in one central SQLite db keyed by
        // `ses_*` ids; `--session <id>` reopens one from anywhere.
        SOURCE_OPENCODE => {
            if !is_plain_session_token(source_session_id) || !source_session_id.starts_with("ses_")
            {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_OPENCODE,
                cli_agent_type: "opencode",
                default_binary: "opencode",
                resume_args: vec!["--session".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // MiMo Code is an OpenCode fork with the same `ses_*` central store
        // and the same `--session <id>` flag (verified against `mimo --help`).
        SOURCE_MIMO_CODE => {
            if !is_plain_session_token(source_session_id) || !source_session_id.starts_with("ses_")
            {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_MIMO_CODE,
                cli_agent_type: "mimo_code",
                default_binary: "mimo",
                resume_args: vec!["--session".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // Cline registers sessions (`<epoch>_<rand>` ids) in a global
        // sessions.db; `--id <session-id>` resumes one by id.
        SOURCE_CLINE => {
            if !is_plain_session_token(source_session_id) {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_CLINE,
                cli_agent_type: "cline",
                default_binary: "cline",
                resume_args: vec!["--id".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // Copilot CLI resumes globally by id. The detached form is the
        // syntax documented by the current binary (`copilot --help`).
        SOURCE_COPILOT => {
            if !is_uuid_like(source_session_id) {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_COPILOT,
                cli_agent_type: "copilot",
                default_binary: "copilot",
                resume_args: vec!["--resume".to_string(), source_session_id.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        // The hardened Kimi importer namespaces legacy CLI and Kimi Code
        // records (`cli/<group>/<id>` and `code/<workspace>/<id>/main`).
        // The owning CLI accepts only the native id, and its picker is
        // cwd-scoped, so resume runs from the recorded workspace. Subagent
        // identities are deliberately rejected: the CLI resumes the parent
        // conversation as a whole.
        SOURCE_KIMI => {
            let native_session_id = kimi_native_session_id(source_session_id)?;
            Some(CliResumePlan {
                source: SOURCE_KIMI,
                cli_agent_type: "kimi_cli",
                default_binary: "kimi",
                resume_args: vec!["--session".to_string(), native_session_id.to_string()],
                native_session_id: native_session_id.to_string(),
                cwd,
                requires_cwd: true,
            })
        }
        // oh-my-pi (pi family) looks bare ids up in the *current project's*
        // session dir, so id-resume is cwd-fragile — but `--session` also
        // accepts an absolute session-file path, which resolves from
        // anywhere. Requires the imported transcript path.
        SOURCE_OMP => {
            let path = source_path.map(str::trim).filter(|path| !path.is_empty())?;
            if !is_plain_session_token(source_session_id) {
                return None;
            }
            Some(CliResumePlan {
                source: SOURCE_OMP,
                cli_agent_type: "omp",
                default_binary: "omp",
                resume_args: vec!["--session".to_string(), path.to_string()],
                native_session_id: source_session_id.to_string(),
                cwd,
                requires_cwd: false,
            })
        }
        _ => None,
    }
}

/// A sane single-token session id: non-empty, no whitespace or quoting
/// hazards. Provider arms add their own shape checks on top.
fn is_plain_session_token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn kimi_native_session_id(source_session_id: &str) -> Option<&str> {
    let parts = source_session_id.split('/').collect::<Vec<_>>();
    let native_session_id = match parts.as_slice() {
        ["cli", group, session_id] if is_plain_session_token(group) => *session_id,
        ["code", workspace, session_id, "main"] if is_plain_session_token(workspace) => *session_id,
        _ => return None,
    };
    is_plain_session_token(native_session_id).then_some(native_session_id)
}

/// Resolve a canonical (prefixed) session id against the imported-history
/// cache and plan its CLI resume. Returns the cache row alongside the plan
/// so hosts can run freshness/availability checks (`source_path` on disk,
/// cwd existence) without a second query. Subagent rows resolve to `None`:
/// their transcripts are children of a conversation the CLI resumes as a
/// whole.
pub fn cli_resume_plan_for_cached_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(CliResumePlan, ImportedHistoryCachedSession)>, String> {
    let Some((source, session)) = query_cached_session_by_session_id_from_conn(conn, session_id)?
    else {
        return Ok(None);
    };
    if session.parent_session_id.is_some() {
        return Ok(None);
    }
    let plan = cli_resume_plan(
        &source,
        &session.source_session_id,
        session.repo_path.as_deref(),
        Some(session.source_path.as_str()),
    );
    Ok(plan.map(|plan| (plan, session)))
}

/// `rollout-<timestamp>-<thread-uuid>` → `<thread-uuid>`. Accepts a bare
/// uuid too (runner bindings and older imports carry that form).
pub(super) fn codex_thread_uuid_from_stem(stem: &str) -> Option<&str> {
    if is_uuid_like(stem) {
        return Some(stem);
    }
    if stem.len() > 37 {
        let (head, tail) = stem.split_at(stem.len() - 36);
        if head.ends_with('-') && is_uuid_like(tail) {
            return Some(tail);
        }
    }
    None
}

pub(super) fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            *byte == b'-'
        } else {
            byte.is_ascii_hexdigit()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID: &str = "019f6e88-3bc8-77b3-9f21-30af8dd9a1cd";

    #[test]
    fn claude_plan_uses_resume_flag_and_requires_cwd() {
        let plan =
            cli_resume_plan(SOURCE_CLAUDE_CODE, UUID, Some("/tmp/project"), None).expect("plan");
        assert_eq!(plan.cli_agent_type, "claude_code");
        assert_eq!(plan.default_binary, "claude");
        assert_eq!(plan.resume_args, vec!["--resume", UUID]);
        assert_eq!(plan.native_session_id, UUID);
        assert_eq!(plan.cwd.as_deref(), Some("/tmp/project"));
        assert!(plan.requires_cwd);
        assert_eq!(plan.display_command(), format!("claude --resume {UUID}"));
    }

    #[test]
    fn claude_rejects_non_uuid_stems() {
        assert!(cli_resume_plan(SOURCE_CLAUDE_CODE, "claude-meta", None, None).is_none());
    }

    #[test]
    fn codex_plan_extracts_thread_uuid_from_rollout_stem() {
        let stem = format!("rollout-2026-07-17T13-24-09-{UUID}");
        let plan = cli_resume_plan(SOURCE_CODEX_APP, &stem, None, None).expect("plan");
        assert_eq!(plan.cli_agent_type, "codex");
        assert_eq!(plan.resume_args, vec!["resume", UUID]);
        assert_eq!(plan.native_session_id, UUID);
        assert!(!plan.requires_cwd);
        assert!(plan.cwd.is_none());
    }

    #[test]
    fn codex_plan_accepts_bare_uuid_and_rejects_boundaryless_suffix() {
        assert!(cli_resume_plan(SOURCE_CODEX_APP, UUID, None, None).is_some());
        // 36 hex-ish tail without a '-' boundary before it must not match.
        let boundaryless = format!("rollout{UUID}");
        assert!(cli_resume_plan(SOURCE_CODEX_APP, &boundaryless, None, None).is_none());
    }

    #[test]
    fn cursor_cli_plan_uses_resume_flag_globally() {
        let plan = cli_resume_plan(SOURCE_CURSOR_CLI, UUID, Some("  "), None).expect("plan");
        assert_eq!(plan.default_binary, "cursor-agent");
        assert_eq!(plan.resume_args, vec!["--resume", UUID]);
        // Blank repo paths normalize away instead of producing a "  " cwd.
        assert!(plan.cwd.is_none());
        assert!(!plan.requires_cwd);
    }

    #[test]
    fn unsupported_sources_yield_no_plan() {
        for source in ["cursor_ide", "windsurf", "warp", "trae", "definitely_not"] {
            assert!(
                cli_resume_plan(source, UUID, None, None).is_none(),
                "{source}"
            );
        }
    }

    #[test]
    fn opencode_family_plans_use_session_flag_and_require_ses_ids() {
        for (source, binary) in [(SOURCE_OPENCODE, "opencode"), (SOURCE_MIMO_CODE, "mimo")] {
            let plan = cli_resume_plan(source, "ses_09189826fffe1Z2F3Yiih6BMdM", None, None)
                .expect("plan");
            assert_eq!(plan.default_binary, binary);
            assert_eq!(
                plan.resume_args,
                vec!["--session", "ses_09189826fffe1Z2F3Yiih6BMdM"]
            );
            assert!(!plan.requires_cwd);
            // Non-ses ids (sqlite artifacts, fixtures) never plan.
            assert!(cli_resume_plan(source, "msg_0123", None, None).is_none());
            assert!(cli_resume_plan(source, "ses_ has space", None, None).is_none());
        }
    }

    #[test]
    fn cline_plan_uses_id_flag() {
        let plan = cli_resume_plan(SOURCE_CLINE, "1784035830913_lu2zm", None, None).expect("plan");
        assert_eq!(plan.default_binary, "cline");
        assert_eq!(plan.resume_args, vec!["--id", "1784035830913_lu2zm"]);
        assert!(!plan.requires_cwd);
    }

    #[test]
    fn copilot_plan_uses_the_documented_resume_flag() {
        let plan = cli_resume_plan(SOURCE_COPILOT, UUID, Some("/tmp/project"), None).expect("plan");
        assert_eq!(plan.cli_agent_type, "copilot");
        assert_eq!(plan.resume_args, vec!["--resume", UUID]);
        assert!(!plan.requires_cwd);
        assert_eq!(plan.display_command(), format!("copilot --resume {UUID}"));
        assert!(cli_resume_plan(SOURCE_COPILOT, "not-a-uuid", None, None).is_none());
    }

    #[test]
    fn kimi_plan_uses_session_flag_and_requires_cwd() {
        let plan = cli_resume_plan(
            SOURCE_KIMI,
            "code/wd_project_hash/abc12345/main",
            Some("/tmp/project"),
            None,
        )
        .expect("plan");
        assert_eq!(plan.cli_agent_type, "kimi_cli");
        assert_eq!(plan.default_binary, "kimi");
        assert_eq!(plan.resume_args, vec!["--session", "abc12345"]);
        assert_eq!(plan.native_session_id, "abc12345");
        assert!(plan.requires_cwd);
        assert!(cli_resume_plan(SOURCE_KIMI, "cli/project/legacy-session", None, None).is_some());
        assert!(cli_resume_plan(
            SOURCE_KIMI,
            "code/wd_project_hash/abc12345/agent-0",
            None,
            None
        )
        .is_none());
        assert!(cli_resume_plan(SOURCE_KIMI, "code/project/has space/main", None, None).is_none());
    }

    #[test]
    fn omp_plan_addresses_the_session_file_and_needs_a_path() {
        let plan = cli_resume_plan(
            SOURCE_OMP,
            "2026-07-20_abcdef01-2345-6789-abcd-ef0123456789",
            Some("/tmp/project"),
            Some("/Users/x/.omp/agent/sessions/-tmp-project/session.jsonl"),
        )
        .expect("plan");
        assert_eq!(plan.default_binary, "omp");
        assert_eq!(
            plan.resume_args,
            vec![
                "--session",
                "/Users/x/.omp/agent/sessions/-tmp-project/session.jsonl"
            ]
        );
        assert!(!plan.requires_cwd);
        // Without the transcript path there is nothing to address.
        assert!(cli_resume_plan(SOURCE_OMP, "stem", Some("/tmp/project"), None).is_none());
        assert!(cli_resume_plan(SOURCE_OMP, "stem", None, Some("  ")).is_none());
    }

    #[test]
    fn display_command_quotes_unsafe_arguments_posix() {
        let mut plan = cli_resume_plan(SOURCE_CLAUDE_CODE, UUID, None, None).expect("plan");
        plan.resume_args = vec!["--resume".to_string(), "a b'c".to_string()];
        // Pinned to POSIX rather than `display_command()` so this assertion
        // is stable regardless of the host OS running the test suite.
        assert_eq!(
            plan.display_command_for_shell(false),
            r#"claude --resume 'a b'\''c'"#
        );
    }

    #[test]
    fn display_command_quotes_unsafe_arguments_powershell_on_windows() {
        let mut plan = cli_resume_plan(SOURCE_CLAUDE_CODE, UUID, None, None).expect("plan");
        // A backslash-heavy Windows path (e.g. omp's `--session <path>`)
        // must pass through unescaped under PowerShell single-quoting,
        // where POSIX's `'\''` escaping would corrupt it.
        plan.resume_args = vec![
            "--session".to_string(),
            r"C:\Users\me\.omp\agent\sessions\a b'c.jsonl".to_string(),
        ];
        assert_eq!(
            plan.display_command_for_shell(true),
            r#"claude --session 'C:\Users\me\.omp\agent\sessions\a b''c.jsonl'"#
        );
    }

    #[test]
    fn shell_quote_matches_shell_quote_for_shell_at_cfg_windows() {
        // `shell_quote` should defer to the host's actual target OS, not
        // silently default to POSIX.
        assert_eq!(
            shell_quote("a b'c"),
            shell_quote_for_shell("a b'c", cfg!(windows))
        );
    }

    #[test]
    fn cached_lookup_plans_only_resumable_rows() {
        use crate::sources::imported_history::metadata::{
            ImportedHistoryCacheInput, ImportedHistoryImpactStats,
        };

        let mut conn = Connection::open_in_memory().expect("open");
        crate::store::sqlite::SqliteRecordStore::init_tables(&conn).expect("init core tables");
        crate::store::sqlite::SqliteRecordStore::init_source_cache_tables(&conn)
            .expect("init source cache tables");

        let input = |source: &'static str, source_session_id: &str, session_id: &str| {
            ImportedHistoryCacheInput {
                source,
                source_session_id: source_session_id.to_string(),
                session_id: session_id.to_string(),
                source_path: "/tmp/source".to_string(),
                source_record_key: source_session_id.to_string(),
                source_mtime_ms: 1,
                source_size_bytes: 1,
                source_fingerprint: "fp".to_string(),
                parser_version: 1,
                name: "session".to_string(),
                created_at_ms: 1,
                updated_at_ms: 2,
                model: None,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                repo_path: Some("/tmp/project".to_string()),
                branch: None,
                impact: ImportedHistoryImpactStats::default(),
                listable: true,
                source_metadata_json: None,
                parent_session_id: None,
                client_origin: None,
                client_origin_raw: None,
            }
        };
        let claude_session_id = format!("claudecodeapp-{UUID}");
        crate::sources::imported_history::cache::upsert_imported_session_cache_from_conn(
            &mut conn,
            &[
                input(SOURCE_CLAUDE_CODE, UUID, &claude_session_id),
                input("opencode", "ses_123", "opencodeapp-ses_123"),
                input("windsurf", "cascade-1", "windsurfapp-cascade-1"),
            ],
        )
        .expect("upsert");

        let (plan, session) = cli_resume_plan_for_cached_session(&conn, &claude_session_id)
            .expect("query")
            .expect("plan");
        assert_eq!(plan.native_session_id, UUID);
        assert_eq!(session.repo_path.as_deref(), Some("/tmp/project"));

        // The cached row's transcript path feeds path-addressed providers.
        let (opencode_plan, opencode_session) =
            cli_resume_plan_for_cached_session(&conn, "opencodeapp-ses_123")
                .expect("query")
                .expect("plan");
        assert_eq!(opencode_plan.resume_args, vec!["--session", "ses_123"]);
        assert_eq!(opencode_session.source_path, "/tmp/source");

        assert!(
            cli_resume_plan_for_cached_session(&conn, "windsurfapp-cascade-1")
                .expect("query")
                .is_none()
        );
        assert!(cli_resume_plan_for_cached_session(&conn, "unknown-id")
            .expect("query")
            .is_none());
    }
}
