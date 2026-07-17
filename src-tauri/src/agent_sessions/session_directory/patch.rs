//! `session_patch` — single Tauri entry point for in-session field edits.
//!
//! # Why this exists
//!
//! Frontend in-session UI (the chat composer's `ModelPalette` and
//! `ModePill`) needs to mutate the *currently active* session's
//! `model` / `account_id` / `agent_exec_mode` and have the change
//! survive (a) navigation away and back, (b) app restart, and (c)
//! background `aggregate_changed` refreshes. The pre-`session_patch`
//! design used jotai atoms (`creatorDefaultModelSelectionAtom`,
//! `creatorDefaultExecModeAtom`) as the source of truth for these
//! values, which silently broke per-session isolation: switching
//! sessions in the inbox dropped the user's earlier choice and global
//! `localStorage` writes leaked between unrelated sessions.
//!
//! # Shape
//!
//! The wire payload is a struct with all fields `Option`. The fields
//! are bundled by *atomic operation* — the only legal combinations are:
//!
//! - `name` set on its own (rename / generated title)
//! - `model` set with optional `account_id` (a model-pick is one user
//!   action; the account binds to the model)
//! - `agent_exec_mode` set on its own (a ModePill click)
//! - both set in one call (the rare "switch model AND mode" case;
//!   still atomic at the SQL level via two `UPDATE` rows under one
//!   command call).
//!
//! Fields that are deliberately *not* exposed:
//!
//! - `key_source` — set once at session create, mis-billing risk if mutable.
//! - `cli_agent_type` — the CLI process is already spawned; switching
//!   would leave a zombie process with the wrong adapter.
//! - `listing_model` — currently piggybacks on `model` for market
//!   sessions; revisit once the market-tier UX settles.
//!
//! ## Three-state fields (P3)
//!
//! `draft_text` and `reply_target_event_id` are *clearable*: the
//! frontend needs to distinguish "leave this column alone" from
//! "explicitly clear this column to NULL". JSON natively has only two
//! states (absent vs present-as-`null`), so we use the dtolnay
//! double-`Option` pattern (`Option<Option<String>>`) with a custom
//! `deserialize_some` so the wire shape lines up:
//!
//! - field absent  → `None`              (leave alone)
//! - field is JSON `null` → `Some(None)` (clear to NULL)
//! - field is a string → `Some(Some(s))` (write that value)
//!
//! Frontend hooks (`useSessionDraftField`, `useSessionReplyField`)
//! send `null` to clear and a string to set.
//!
//! # Routing
//!
//! Sessions live in two tables:
//!
//! - `code_sessions` (CLI agents) — has `model` + `account_id` + `agent_exec_mode`.
//! - `agent_sessions` (Rust agents) — has all three.
//!
//! `session_patch` first locates which table owns `session_id`, then
//! routes the writes to the matching helper so Rust and CLI sessions use
//! the same per-session ModePill storage contract.

use rusqlite::{params, OptionalExtension, Result as SqliteResult};
use serde::{Deserialize, Deserializer, Serialize};

use crate::agent_sessions::cli::persistence as cli_persistence;
use agent_core::session::persistence as session_persistence;
use database::db::get_connection;

/// Deserialize a JSON value into `Some(_)` even if the value is `null`.
/// Combined with `#[serde(default)]`, this is the canonical recipe to
/// distinguish absent (`None`) from `null` (`Some(None)`) for double-
/// `Option<Option<T>>` fields. See the module-level "three-state
/// fields" docs for why we need it.
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// Wire payload for `session_patch`.
///
/// All fields are `Option` — `None` means "leave this column alone".
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatch {
    /// Display title for the session. Metadata write only; does not bump
    /// `updated_at` because renaming is not conversation activity.
    pub name: Option<String>,
    /// New model identifier (e.g. `"claude-sonnet-4-5"`). When `Some`,
    /// `account_id` is written in the same statement so a model+key
    /// pair never appears in a half-applied state.
    pub model: Option<String>,
    /// Account ID associated with the new model. Only meaningful
    /// alongside `model`; passing it without `model` is rejected.
    pub account_id: Option<String>,
    /// Per-session execution mode. Only legal for `agent_sessions`
    /// rows; rejected for CLI sessions.
    pub agent_exec_mode: Option<String>,
    /// Per-session unsent draft text (P3). Three-state — see the
    /// "three-state fields" section in module docs.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_some"
    )]
    pub draft_text: Option<Option<String>>,
    /// Per-session reply target event id (P3). Three-state — `None`
    /// leaves it alone, `Some(None)` clears it, `Some(Some(id))` sets it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_some"
    )]
    pub reply_target_event_id: Option<Option<String>>,
    /// Pin/unpin toggle (P5). `None` means "leave alone".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

/// Which table owns `session_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionLocation {
    Cli,
    Agent,
}

fn locate_session(session_id: &str) -> SqliteResult<Option<SessionLocation>> {
    let conn = get_connection()?;
    // Single round-trip lookup — `agent_sessions` first because Rust
    // agents dominate the active session population.
    let agent_hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM agent_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    if agent_hit.is_some() {
        return Ok(Some(SessionLocation::Agent));
    }
    let cli_hit: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    if cli_hit.is_some() {
        return Ok(Some(SessionLocation::Cli));
    }
    Ok(None)
}

/// Reject account/model pairs that can never serve a turn (G10 of the
/// account-switch audit): a vanished/disabled vault account, or a model
/// outside the account's enabled set (e.g. keeping `claude-sonnet-*` while
/// switching to an OpenAI API key) used to surface only as an HTTP-layer
/// error on the NEXT turn. Failing the patch up-front gives the frontend
/// rollback path a useful message instead.
///
/// Matching is deliberately lenient (exact, prefix in either direction, or
/// alias) because palette model ids may carry variant suffixes; an empty
/// `enabled_models` list means "no restriction" (e.g. fallback-populated
/// native accounts).
fn validate_account_model_compat(account_id: &str, model: &str) -> Result<(), String> {
    let Some(key) = key_vault::key_store::KEY_SERVICE.get_key_by_id(account_id) else {
        return Err(format!(
            "session_patch: account {account_id} not found in key vault"
        ));
    };
    if !key.enabled {
        return Err(format!("session_patch: account {account_id} is disabled"));
    }
    if key.enabled_models.is_empty() {
        return Ok(());
    }
    let compatible = key.enabled_models.iter().any(|enabled| {
        enabled == model || model.starts_with(enabled.as_str()) || enabled.starts_with(model)
    }) || key.model_aliases.iter().any(|alias| alias.alias == model);
    if !compatible {
        return Err(format!(
            "session_patch: model {model} is not enabled for account {account_id} \
             (enabled: {:?})",
            key.enabled_models
        ));
    }
    Ok(())
}

/// Apply a patch synchronously. Public for `#[tauri::command]`
/// adapter; tests can also call this directly with an in-memory DB
/// once the connection abstraction allows it.
pub fn apply_session_patch(session_id: &str, patch: &SessionPatch) -> Result<(), String> {
    // Reject the only structurally-invalid combination upfront so the
    // frontend gets a useful error instead of a silent no-op.
    if patch.account_id.is_some() && patch.model.is_none() {
        return Err(
            "session_patch: account_id provided without model — pair them in the same call"
                .to_string(),
        );
    }
    if let (Some(account_id), Some(model)) = (patch.account_id.as_deref(), patch.model.as_deref()) {
        validate_account_model_compat(account_id, model)?;
    }
    if patch.name.is_none()
        && patch.model.is_none()
        && patch.agent_exec_mode.is_none()
        && patch.draft_text.is_none()
        && patch.reply_target_event_id.is_none()
        && patch.pinned.is_none()
    {
        return Err("session_patch: at least one field must be set".to_string());
    }

    let location = locate_session(session_id)
        .map_err(|err| format!("session_patch lookup failed: {err}"))?
        .ok_or_else(|| format!("session_patch: session {session_id} not found"))?;

    if let Some(name) = patch.name.as_deref() {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("session_patch: name cannot be empty".to_string());
        }
        match location {
            SessionLocation::Agent => {
                session_persistence::update_name(session_id, trimmed)
                    .map_err(|err| format!("session_patch update name (agent): {err}"))?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_name(session_id, trimmed)
                    .map_err(|err| format!("session_patch update name (cli): {err}"))?;
            }
        }
    }

    if let Some(model) = patch.model.as_deref() {
        match location {
            SessionLocation::Agent => {
                session_persistence::update_model_and_account(
                    session_id,
                    model,
                    patch.account_id.as_deref(),
                )
                .map_err(|err| format!("session_patch update model (agent): {err}"))?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_model_and_account(
                    session_id,
                    Some(model),
                    patch.account_id.as_deref(),
                )
                .map_err(|err| format!("session_patch update model (cli): {err}"))?;
            }
        }
    }

    if let Some(mode) = patch.agent_exec_mode.as_deref() {
        match location {
            SessionLocation::Agent => {
                session_persistence::update_agent_exec_mode(session_id, mode).map_err(|err| {
                    format!("session_patch update agent_exec_mode (agent): {err}")
                })?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_agent_exec_mode(session_id, mode)
                    .map_err(|err| format!("session_patch update agent_exec_mode (cli): {err}"))?;
            }
        }
    }

    // Three-state writes (P3). The outer `Option` tells us whether the
    // frontend touched the field at all; the inner `Option` carries the
    // actual value (`None` → SQL NULL = clear). We route to whichever
    // table owns this session_id; both tables expose the same helper
    // signature, but the agent_core helpers do empty-string
    // normalization on the draft so an "" payload is treated as a
    // clear.
    if let Some(draft) = patch.draft_text.as_ref() {
        let value = draft.as_deref();
        match location {
            SessionLocation::Agent => {
                session_persistence::update_draft_text(session_id, value)
                    .map_err(|err| format!("session_patch update draft_text (agent): {err}"))?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_draft_text(session_id, value)
                    .map_err(|err| format!("session_patch update draft_text (cli): {err}"))?;
            }
        }
    }

    if let Some(reply) = patch.reply_target_event_id.as_ref() {
        let value = reply.as_deref();
        match location {
            SessionLocation::Agent => {
                session_persistence::update_reply_target_event_id(session_id, value).map_err(
                    |err| format!("session_patch update reply_target_event_id (agent): {err}"),
                )?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_reply_target_event_id(session_id, value).map_err(
                    |err| format!("session_patch update reply_target_event_id (cli): {err}"),
                )?;
            }
        }
    }
    if let Some(pinned) = patch.pinned {
        match location {
            SessionLocation::Agent => {
                session_persistence::update_pinned(session_id, pinned)
                    .map_err(|err| format!("session_patch update pinned (agent): {err}"))?;
            }
            SessionLocation::Cli => {
                cli_persistence::update_pinned(session_id, pinned)
                    .map_err(|err| format!("session_patch update pinned (cli): {err}"))?;
            }
        }
    }

    Ok(())
}

/// Read the session's current account_id from whichever table owns it.
/// Used to populate `fromAccountId` on the account-switched event.
fn read_current_account(session_id: &str) -> Option<String> {
    let conn = get_connection().ok()?;
    conn.query_row(
        "SELECT account_id FROM agent_sessions WHERE session_id = ?1",
        params![session_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .ok()
    .flatten()
    .or_else(|| {
        conn.query_row(
            "SELECT account_id FROM code_sessions WHERE session_id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
    })
    .flatten()
}

/// Tauri command: partial update of an existing session row.
///
/// See module docs for the supported field set and routing rules.
#[tauri::command]
pub async fn session_patch(
    state: tauri::State<'_, agent_core::state::AgentAppState>,
    session_id: String,
    patch: SessionPatch,
) -> Result<(), String> {
    let identity_changed = patch.model.is_some();
    let renamed = patch
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let switched_account = patch.account_id.clone();
    let switched_model = patch.model.clone();
    let patched_session_id = session_id.clone();
    let prev_account = tokio::task::spawn_blocking(move || {
        let prev_account = patch
            .account_id
            .is_some()
            .then(|| read_current_account(&session_id))
            .flatten();
        apply_session_patch(&session_id, &patch).map(|()| prev_account)
    })
    .await
    .map_err(|err| format!("session_patch task join error: {err}"))??;
    if identity_changed {
        state.invalidate_session(&patched_session_id).await;
    }
    if let Some(name) = renamed.as_deref() {
        agent_core::lifecycle::emit_session_renamed(
            state.app_handle.as_ref(),
            &patched_session_id,
            name,
        );
    }
    if let Some(to_account) = switched_account.as_deref() {
        if prev_account.as_deref() != Some(to_account) {
            agent_core::lifecycle::emit_session_account_switched(
                state.app_handle.as_ref(),
                &patched_session_id,
                prev_account.as_deref(),
                to_account,
                switched_model.as_deref(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn double_option_distinguishes_absent_null_value() {
        // Field absent → None → "leave alone"
        let absent: SessionPatch = serde_json::from_str("{}").unwrap();
        assert!(absent.draft_text.is_none());
        assert!(absent.reply_target_event_id.is_none());

        // Field is JSON null → Some(None) → "clear"
        let nulled: SessionPatch =
            serde_json::from_str(r#"{"draftText": null, "replyTargetEventId": null}"#).unwrap();
        assert_eq!(nulled.draft_text, Some(None));
        assert_eq!(nulled.reply_target_event_id, Some(None));

        // Field is a string → Some(Some(_)) → "set"
        let set: SessionPatch =
            serde_json::from_str(r#"{"draftText": "hello", "replyTargetEventId": "evt_42"}"#)
                .unwrap();
        assert_eq!(set.draft_text, Some(Some("hello".to_string())));
        assert_eq!(set.reply_target_event_id, Some(Some("evt_42".to_string())));
    }

    #[test]
    fn empty_patch_is_rejected() {
        let patch = SessionPatch::default();
        let err = apply_session_patch("nonexistent", &patch).unwrap_err();
        assert!(err.contains("at least one field"), "got: {err}");
    }

    #[test]
    fn account_without_model_is_rejected() {
        let patch = SessionPatch {
            account_id: Some("acc_1".to_string()),
            ..SessionPatch::default()
        };
        let err = apply_session_patch("nonexistent", &patch).unwrap_err();
        assert!(
            err.contains("account_id provided without model"),
            "got: {err}"
        );
    }
}
