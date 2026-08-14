//! Regression pin for config-driven extract-memories opt-in.
//!
//! All other extract-memories scenarios pass the
//! `enable_extract_memories` HTTP flag on `/agent/test/sde`, which patches
//! the agent definition before session init and bypasses the overlay
//! resolver. That means none of them would catch a regression where
//! `ResolvedAgent::resolve` fails to pick up the
//! `learnings.extract_memories_enabled` overlay installed on a
//! builtin agent definition.
//!
//! This scenario exercises the production opt-in path — the same
//! resolver chain a normal user hits when they enable extract-memories
//! through agent-config — instead of the test-only HTTP shortcut:
//!   1. Overlay `builtin:sde` via `/agent/test/agent-config/set` with
//!      `extract_memories_enabled=true`.
//!   2. Send a tool-heavy SDE turn with the `enable_extract_memories`
//!      HTTP flag left **off**.
//!   3. Assert `em_state.last_processed_seq` advances — only possible
//!      if the resolver honored the overlay.
//!
//! Positive+negative assertion compliance: teardown resets the overlay so the next scenario
//! (and any future negative counterpart) observes a clean baseline.

use std::path::Path;
use std::time::Duration;

use crate::config::Config;
use crate::harness::{self, SdeMessageOpts};

use super::tmp_workspace_path;

const WAIT_AFTER_TURN_SECS: u64 = 60;
const POLL_INTERVAL_MS: u64 = 500;
const TOOL_HEAVY_PROMPT: &str = "I just opened this repo. List this \
     directory and read any README you find, then briefly tell me what \
     build tool this repo uses. Keep your answer to one sentence.";
const README_BODY: &str = "# Agent-Def Opt-In Test\n\n\
     This workspace exercises the builtin:sde agent-definition overlay \
     for extract-memories. The repo uses Bazel exclusively for Rust builds.\n";

fn seed_workspace(label: &str) -> Result<String, String> {
    let project = tmp_workspace_path(label);
    let workspace = Path::new(&project);
    let _ = std::fs::remove_dir_all(workspace.join(".orgii"));
    std::fs::write(workspace.join("README.md"), README_BODY)
        .map_err(|err| format!("seed README: {err}"))?;
    Ok(project)
}

fn cleanup_workspace(project: &str) {
    let workspace = Path::new(project);
    let _ = std::fs::remove_file(workspace.join("README.md"));
    let _ = std::fs::remove_dir_all(workspace.join(".orgii"));
}

/// Positive: flipping `extract_memories_enabled=true` on the
/// `builtin:sde` agent definition must propagate through the resolver
/// to `SessionRuntime.resolved`, even when no HTTP wire flag opts in.
/// Asserts the em_state cursor advances, which only happens if the
/// resolver actually read the overlay.
pub async fn extract_memories_agent_def_opts_in(cfg: &Config) -> bool {
    const AGENT_ID: &str = "builtin:sde";

    let session_id = format!("{}-emdef-in", cfg.session_prefix);
    let project = match seed_workspace("emdef-in") {
        Ok(p) => p,
        Err(err) => {
            return harness::print_error("Extract Memories Agent-Def Opts In", &err);
        }
    };

    println!("  [step 1] Overlaying {AGENT_ID} with extract_memories_enabled=true...");
    let applied = harness::set_agent_config(
        cfg,
        serde_json::json!({
            "agent_id": AGENT_ID,
            "extract_memories_enabled": true,
        }),
    )
    .await;
    let overlay_applied = applied
        .as_ref()
        .ok()
        .and_then(|v| v.get("extract_memories_enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Err(ref err) = applied {
        println!("  [warn] overlay set failed: {err}");
    }

    println!("  [step 2] Sending tool-heavy turn WITHOUT enable_extract_memories HTTP flag...");
    let opts = SdeMessageOpts {
        no_cleanup: true,
        ..Default::default()
    };
    let resp = harness::send_sde_message_with_opts(
        cfg,
        TOOL_HEAVY_PROMPT,
        &session_id,
        "build",
        &project,
        &opts,
    )
    .await;

    let turn_ok = resp.is_ok();
    let tool_count = resp
        .as_ref()
        .ok()
        .and_then(|r| r.tool_calls_count)
        .unwrap_or(0);
    if let Err(ref err) = resp {
        println!("  [warn] turn failed: {err}");
    }
    println!("  [info] turn_ok={turn_ok} tool_calls_count={tool_count}");

    println!(
        "  [step 3] Polling em_state for up to {WAIT_AFTER_TURN_SECS}s — \
         agent-def overlay should have turned extract on..."
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(WAIT_AFTER_TURN_SECS);
    let mut last_snapshot: Option<harness::EmStateSnapshot> = None;
    loop {
        match harness::fetch_em_state(cfg, &session_id).await {
            Ok(snap) => {
                let advanced = snap.last_processed_seq.is_some();
                last_snapshot = Some(snap);
                if advanced {
                    break;
                }
            }
            Err(err) => {
                println!("  [warn] fetch_em_state transient error: {err}");
            }
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    }

    let (cursor_advanced, snap_repr) = match last_snapshot.as_ref() {
        Some(snap) => (
            snap.last_processed_seq.is_some(),
            format!(
                "last_processed_seq={:?} in_progress={} turns_since_extraction={}",
                snap.last_processed_seq, snap.in_progress, snap.turns_since_extraction,
            ),
        ),
        None => (false, "em_state fetch never succeeded".to_string()),
    };

    let _ = harness::cleanup_sde_session(cfg, &session_id).await;
    cleanup_workspace(&project);
    harness::reset_agent_config(cfg, AGENT_ID).await;

    harness::print_result(
        "Extract Memories Agent-Def Opts In",
        &format!("turn_ok={turn_ok} tool_calls={tool_count} {snap_repr}"),
        &[
            ("Overlay applied via agent-config/set", overlay_applied),
            ("SDE turn succeeded", turn_ok),
            ("Turn was tool-heavy", tool_count >= 1),
            (
                "em_state cursor advanced (agent-def overlay actually opted in)",
                cursor_advanced,
            ),
        ],
    )
}
