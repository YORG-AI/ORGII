//! Unified session identity resolution.
//!
//! All callers of `send_message_impl` share one resolution path for the
//! session identity fields: model, account_id, native_harness_type, and
//! workspace_root. This eliminates the 5-way copy-paste that caused
//! manage_todo-disabled, model-is-required, and account-lost bugs.

use std::path::PathBuf;

use crate::session::persistence as session_persistence;
use crate::state::AgentAppState;
use core_types::providers::NativeHarnessType;

/// Resolved session identity — every field is non-optional by design.
///
/// `workspace_root` is always a valid, usable path. It is the agent's
/// effective working directory, NOT the user-visible workspace root, and
/// is therefore equal to `SessionWorkspace::working_dir()`:
///   - SDE/Wingman non-worktree sessions: the workspace directory supplied
///     by the caller (== `workspace_root` == `working_dir`).
///   - SDE/Wingman worktree sessions: the shadow checkout under
///     `~/.orgii/.../worktrees/...` (== `working_dir`, ≠ `workspace_root`).
///   - OS Agent sessions: `~/.orgii/personal/workspace/` (regardless of
///     whether launched from UI or a messaging channel).
///
/// This is THE one source of truth for "where does the agent's cwd
/// live for this session?" — DB columns `workspace_path` and
/// `worktree_path` are storage projections of `SessionWorkspace`
/// (see `core::session::persistence::crud::workspace::load_workspace`).
pub(super) struct SessionIdentity {
    pub(super) model: String,
    pub(super) account_id: Option<String>,
    pub(super) native_harness_type: Option<NativeHarnessType>,
    pub(super) workspace_root: PathBuf,
    /// A loaded Agent Org runtime already knows its authoritative Run id.
    /// Keeping that hint here lets the send boundary enforce Team lifecycle
    /// before it creates a Provider without querying ordinary SDE sessions.
    pub(super) agent_org_run_id_hint: Option<String>,
    /// Unloaded Agent Org root/member sessions carry a canonical member id in
    /// persistence. Only those sessions need the bounded parent-walk lookup;
    /// ordinary SDE sessions stay on the existing zero-Agent-Org-query path.
    pub(super) has_persisted_agent_org_identity: bool,
}

/// Caller-supplied overrides. Fields that are `None` are resolved from
/// the runtime cache or DB. Build all fields `None` with the struct
/// literal (`IdentityOverrides { model: None, account_id: None,
/// native_harness_type: None, workspace_root: None }`) when the caller has nothing to override.
///
/// `workspace_root` here is also a `SessionWorkspace.working_dir`
/// projection — caller is responsible for sending the worktree
/// shadow path (not the user-visible workspace root) when the session
/// is a worktree session. Today the only non-`None` callsite is
/// the work-item launch path, which does not produce worktree
/// sessions, so the projection is identity. If a future caller
/// passes a worktree session here, send `working_dir` not
/// `workspace_root`.
#[derive(Default)]
pub struct IdentityOverrides {
    pub model: Option<String>,
    pub account_id: Option<String>,
    pub native_harness_type: Option<NativeHarnessType>,
    pub workspace_root: Option<String>,
}

/// Resolve session identity with a strict priority chain (same for all
/// three fields):
///   1. Caller-supplied overrides
///   2. In-memory runtime cache (`SessionRuntime`)
///   3. DB persistence record (`UnifiedSessionRecord`)
///   4. For OS Agent sessions: `personal_workspace()` fallback (workspace only)
///   5. **Err** — no silent defaults
///
/// The DB query is lazy: only issued when at least one field still needs
/// resolution after layers 1+2. A single `get_session` call is shared
/// across all three fields to avoid redundant queries.
///
/// DB and task-join errors are propagated, never swallowed.
pub(super) async fn resolve_session_identity(
    state: &AgentAppState,
    session_id: &str,
    overrides: IdentityOverrides,
) -> Result<SessionIdentity, String> {
    let personal_ws = crate::definitions::prefix_lookup::uses_personal_workspace(session_id);

    let cached_runtime = if let Some(session) = state.get_session(session_id).await {
        session.get_runtime().await
    } else {
        None
    };

    // ── Layer 1+2 merge (overrides → runtime) ────────────────────────────
    let model_after_l2 = overrides
        .model
        .or_else(|| cached_runtime.as_ref().map(|r| r.model.clone()))
        .filter(|m| !m.is_empty());

    let account_after_l2 = overrides
        .account_id
        .or_else(|| cached_runtime.as_ref().and_then(|r| r.account_id.clone()));

    let workspace_after_l2 = overrides.workspace_root.clone().or_else(|| {
        cached_runtime.as_ref().map(|r| {
            r.workspace_state
                .read()
                .working_dir()
                .to_string_lossy()
                .into_owned()
        })
    });

    let native_harness_after_l2 = overrides
        .native_harness_type
        .or_else(|| cached_runtime.as_ref().and_then(|r| r.native_harness_type));
    let agent_org_run_id_hint = cached_runtime
        .as_ref()
        .and_then(|runtime| runtime.agent_org_context.as_ref())
        .map(|context| context.run_id.clone());

    // ── Layer 3: DB (lazy — only when at least one field still needs it) ─
    let needs_db = model_after_l2.is_none()
        || account_after_l2.is_none()
        || workspace_after_l2.is_none()
        || native_harness_after_l2.is_none();

    let db_record = if needs_db {
        let sid = session_id.to_string();
        let join_result =
            tokio::task::spawn_blocking(move || session_persistence::get_session(&sid)).await;
        match join_result {
            Ok(Ok(record)) => record,
            Ok(Err(db_err)) => {
                return Err(format!(
                    "DB error resolving session identity for {}: {}",
                    session_id, db_err
                ));
            }
            Err(join_err) => {
                return Err(format!(
                    "Task panic resolving session identity for {}: {}",
                    session_id, join_err
                ));
            }
        }
    } else {
        None
    };

    // ── Model ────────────────────────────────────────────────────────────
    let model = model_after_l2
        .or_else(|| {
            db_record
                .as_ref()
                .and_then(|r| r.model.clone())
                .filter(|m| !m.is_empty())
        })
        .ok_or_else(|| {
            format!(
                "model is required for session {} (not in overrides, runtime, or DB)",
                session_id
            )
        })?;

    // ── Account ID ───────────────────────────────────────────────────────
    let account_id =
        account_after_l2.or_else(|| db_record.as_ref().and_then(|r| r.account_id.clone()));

    let native_harness_from_db = db_record
        .as_ref()
        .and_then(|record| record.native_harness_type.as_deref())
        .filter(|value| !value.is_empty())
        .map(|value| {
            NativeHarnessType::parse(value)
                .ok_or_else(|| format!("Unknown native_harness_type in DB: {value:?}"))
        })
        .transpose()?;
    let native_harness_type = native_harness_after_l2.or(native_harness_from_db);
    // The Agent Org send fence keys off this probe, so its reachability must
    // not depend on the unrelated `needs_db` condition: a fully cache-hit
    // send would otherwise silently skip the Team lifecycle fence. When the
    // DB row was not loaded, a runtime that already carries its org context
    // answers directly; ordinary cache-hit sessions pay one indexed point
    // read of `org_member_id`.
    let has_persisted_agent_org_identity = match db_record.as_ref() {
        Some(record) => record.org_member_id.is_some(),
        None if agent_org_run_id_hint.is_some() => true,
        None => {
            let sid = session_id.to_string();
            tokio::task::spawn_blocking(move || session_persistence::get_org_member_id(&sid))
                .await
                .map_err(|join_err| {
                    format!(
                        "Task panic probing Agent Org identity for {}: {}",
                        session_id, join_err
                    )
                })?
                .map_err(|db_err| {
                    format!(
                        "DB error probing Agent Org identity for {}: {}",
                        session_id, db_err
                    )
                })?
                .is_some()
        }
    };

    // ── Workspace Root ───────────────────────────────────────────────────
    //
    // For Layer 3 (DB), we MUST resolve to `working_dir`, not raw
    // `workspace_path`. `workspace_path` is the `workspace_root` projection
    // (user-visible identity); the agent's actual cwd is `working_dir`,
    // which equals `worktree_path` for worktree sessions and falls
    // back to `workspace_path` otherwise (matches `load_workspace`'s
    // unwrap_or_else). Reading `workspace_path` directly silently sends a
    // worktree session's file tools onto the user's real project tree
    // — same family of split-brain as the `key_source` bug (P0). We
    // reuse `db_record` (already in hand) instead of issuing a second
    // `load_workspace` query for the same row.
    let workspace_root = match workspace_after_l2 {
        Some(ref path) if path.is_empty() && personal_ws => app_paths::personal_workspace(),
        Some(ref path) if path.is_empty() => {
            return Err(format!(
                "workspace_root is empty for session {}",
                session_id
            ));
        }
        Some(path) => PathBuf::from(path),
        None => {
            let from_db = db_record.as_ref().and_then(|r| {
                workspace_paths_to_working_dir(
                    r.workspace_path.as_deref(),
                    r.worktree_path.as_deref(),
                )
            });
            match from_db {
                Some(path) => path,
                None if personal_ws => app_paths::personal_workspace(),
                None => {
                    return Err(format!(
                        "Cannot resolve workspace_root for session {} \
                         (not in overrides, runtime, or DB)",
                        session_id
                    ));
                }
            }
        }
    };

    Ok(SessionIdentity {
        model,
        account_id,
        workspace_root,
        native_harness_type,
        agent_org_run_id_hint,
        has_persisted_agent_org_identity,
    })
}

/// Project the `(workspace_path, worktree_path)` DB column pair onto a
/// single `working_dir` `PathBuf`, which is what `SessionIdentity.
/// workspace_root` is meant to carry (the agent's effective cwd).
///
/// Mirrors `load_workspace`'s reconstruction:
/// - Worktree session: `worktree_path` is non-NULL and ≠ workspace_path
///   → use `worktree_path` (== `SessionWorkspace.working_dir`).
/// - Non-worktree session: `worktree_path` is NULL → fall back to
///   `workspace_path` (workspace_root collapses onto working_dir).
/// - No workspace_path at all (pure-channel OS session): returns `None`
///   so the caller can fall back to `personal_workspace()`.
///
/// Returns `None` when `workspace_path` is missing/empty so the caller
/// can decide whether `personal_workspace()` is a legitimate fallback
/// for the session's prefix or whether to error out.
fn workspace_paths_to_working_dir(
    workspace_path: Option<&str>,
    worktree_path: Option<&str>,
) -> Option<PathBuf> {
    let workspace_path = workspace_path.filter(|p| !p.is_empty())?;
    Some(
        worktree_path
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(workspace_path)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worktree_session_resolves_to_worktree_path() {
        // Worktree session: workspace_path is the user's project,
        // worktree_path is the shadow checkout. workspace_root must
        // equal the shadow checkout — sending file tools to the user's
        // real project would defeat worktree isolation (and was the
        // bug that motivated this helper).
        let resolved = workspace_paths_to_working_dir(
            Some("/home/user/myproj"),
            Some("/home/user/.orgii/worktrees/sde-abc"),
        );
        assert_eq!(
            resolved,
            Some(PathBuf::from("/home/user/.orgii/worktrees/sde-abc")),
            "worktree session must surface working_dir, not workspace_root"
        );
    }

    #[test]
    fn non_worktree_session_falls_back_to_workspace_path() {
        // Non-worktree session: worktree_path is NULL because
        // working_dir == workspace_root and `save_workspace` writes
        // NULL on identity. Resolution collapses to workspace_path.
        let resolved = workspace_paths_to_working_dir(Some("/home/user/myproj"), None);
        assert_eq!(resolved, Some(PathBuf::from("/home/user/myproj")));
    }

    #[test]
    fn empty_worktree_path_treated_as_null() {
        // Defensive: legacy rows or future bugs might write "" instead
        // of NULL. Treat empty strings as "no worktree override" so we
        // collapse onto workspace_path rather than producing a `""` cwd.
        let resolved = workspace_paths_to_working_dir(Some("/home/user/myproj"), Some(""));
        assert_eq!(resolved, Some(PathBuf::from("/home/user/myproj")));
    }

    #[test]
    fn missing_workspace_path_returns_none() {
        // Pure-channel OS sessions can have no workspace_path. The
        // identity resolver decides whether to fall back to
        // `personal_workspace()` or error out, so we just signal None.
        assert_eq!(workspace_paths_to_working_dir(None, None), None);
        assert_eq!(
            workspace_paths_to_working_dir(None, Some("/should/not/be/used")),
            None,
            "worktree_path is meaningless without a workspace_path"
        );
    }

    #[test]
    fn empty_workspace_path_returns_none() {
        assert_eq!(workspace_paths_to_working_dir(Some(""), None), None);
        assert_eq!(
            workspace_paths_to_working_dir(Some(""), Some("/x")),
            None,
            "empty workspace_path treated the same as missing"
        );
    }
}
