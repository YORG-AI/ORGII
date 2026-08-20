//! State-level assertion for L1 Session Memory.
//!
//! This scenario proves SM actually fired by reading the persisted
//! `agent_sessions.sm_content` column directly from `~/.orgii/sessions.db`.
//!
//! To force SM extraction past the default `min_tokens_to_init = 10_000`
//! threshold, each turn's prompt is padded with a large inlined payload
//! so a single turn crosses ~10k tokens in message history.

use super::tmp_workspace_path;
use crate::config::Config;
use crate::harness;
use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

const SM_MIN_CONTENT_LEN: usize = 50;
const SM_WAIT_AFTER_LAST_TURN_SECS: u64 = 120;

/// Build a ~12KB filler payload that dominates the turn's token footprint
/// so `current_tokens` reliably crosses `min_tokens_to_init = 10_000`.
/// Content is deterministic but unique per turn so SM has something to summarize.
fn large_payload(turn_label: &str) -> String {
    let line = format!(
        "turn={turn_label} — architecture note: session memory should summarize \
         config keys, file names, and numeric constants established earlier. \
         Do NOT drop the database host, port, or max_connections values. \
         Bazel remote cache URL grpcs://cache.company.com must be preserved.\n"
    );
    // ~220 bytes/line × 60 lines ≈ 13KB — single turn exceeds 10k-token init threshold.
    line.repeat(60)
}

fn sessions_db_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".orgii")
        .join("sessions.db")
}

/// Returns `(sm_content, sm_last_seq)`; both `None` if row missing or columns null.
fn read_sm_state(session_id: &str) -> Result<(Option<String>, Option<i64>), String> {
    let path = sessions_db_path();
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("open {}: {}", path.display(), err))?;

    let row = conn.query_row(
        "SELECT sm_content, sm_last_seq FROM agent_sessions WHERE session_id = ?1",
        [session_id],
        |row| {
            let content: Option<String> = row.get(0)?;
            let last_idx: Option<i64> = row.get(1)?;
            Ok((content, last_idx))
        },
    );

    match row {
        Ok(pair) => Ok(pair),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok((None, None)),
        Err(err) => Err(format!("query sm_content: {}", err)),
    }
}

/// Verify that L1 Session Memory extraction ran and `sm_content` was
/// persisted to `agent_sessions`. Uses large-payload turns to force the
/// default 10k-token init threshold.
pub async fn session_memory_persisted(cfg: &Config) -> bool {
    let session_id = format!("{}-sm-persisted", cfg.session_prefix);
    let project = tmp_workspace_path("sm-persisted");

    let filler1 = large_payload("1");
    let filler2 = large_payload("2");
    let filler3 = large_payload("3");

    let turn1 = harness::send_sde_message(
        cfg,
        &format!(
            "Context block (do not summarize yet, just acknowledge):\n{filler1}\n\n\
             Task: note these config values for later — database_host=atlas-prod-7.example.com, \
             port=5433, max_connections=42. Respond briefly."
        ),
        &session_id,
        "build",
        &project,
        None,
        true,
    )
    .await;
    let turn1_ok = turn1.is_ok();

    let turn2 = harness::send_sde_message(
        cfg,
        &format!(
            "More context (acknowledge only):\n{filler2}\n\n\
             Task: now consider the ssl_mode=verify-full setting. Respond briefly."
        ),
        &session_id,
        "build",
        &project,
        None,
        true,
    )
    .await;
    let turn2_ok = turn2.is_ok();

    let turn3 = harness::send_sde_message(
        cfg,
        &format!(
            "Final context block (acknowledge only):\n{filler3}\n\n\
             Task: summarize the config from previous turns in one sentence."
        ),
        &session_id,
        "build",
        &project,
        None,
        true,
    )
    .await;
    let turn3_ok = turn3.is_ok();

    // SM extraction is coordinator-owned and can queue behind other
    // sessions' memory jobs on the global permit, so poll the durable row
    // instead of sleeping a fixed interval.
    let poll_deadline =
        std::time::Instant::now() + Duration::from_secs(SM_WAIT_AFTER_LAST_TURN_SECS);
    let mut db_read = read_sm_state(&session_id);
    while std::time::Instant::now() < poll_deadline {
        if matches!(&db_read, Ok((Some(_), _))) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
        db_read = read_sm_state(&session_id);
    }

    // Clean up the session so we don't leak runtime state.
    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    let (sm_content, sm_last_idx) = match db_read {
        Ok(pair) => pair,
        Err(err) => return harness::print_error("Session Memory Persisted", &err),
    };

    let content_len = sm_content.as_deref().map(|s| s.len()).unwrap_or(0);
    let content_non_null = sm_content.is_some();
    let content_non_trivial = content_len >= SM_MIN_CONTENT_LEN;
    let idx_set = sm_last_idx.is_some();

    let preview = sm_content
        .as_deref()
        .map(|s| s.chars().take(200).collect::<String>())
        .unwrap_or_else(|| "<null>".to_string());

    harness::print_result(
        "Session Memory Persisted",
        &preview,
        &[
            ("Turn 1 ok (large payload)", turn1_ok),
            ("Turn 2 ok (large payload)", turn2_ok),
            ("Turn 3 ok (large payload)", turn3_ok),
            ("sm_content persisted (non-null)", content_non_null),
            (
                &format!("sm_content length >= {SM_MIN_CONTENT_LEN} (got {content_len})"),
                content_non_trivial,
            ),
            ("sm_last_seq persisted (non-null)", idx_set),
        ],
    )
}
