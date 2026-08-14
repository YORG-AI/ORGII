//! State-level assertion for L1→L2 auto-dream consolidation.
//!
//! Auto-dream is gated by three conditions:
//!   1. Time gate: >= 24h since last consolidation
//!   2. Session gate: >= 5 session `.jsonl` files touched since last
//!   3. Lock gate: no other process currently consolidating
//!
//! For e2e we force (1) by starting with no prior lock, and force (2) by
//! writing fake session `.jsonl` files under `{project}/.orgii/sessions/`.
//!
//! We then send a single SDE turn with `enable_auto_dream: true` and assert
//! the filesystem side-effects: the `.consolidate-lock` file appears inside
//! `{project}/.orgii/workspace-memory/` and its body is the tauri dev server's
//! PID (meaning an actual consolidation attempt fired, not just scheduling).

use std::path::Path;
use std::time::Duration;

use crate::config::Config;
use crate::harness;

use super::tmp_workspace_path;

const MIN_SESSIONS: usize = 5;
/// Auto-dream is coordinator-owned and serializes behind the session's own
/// session-memory and workspace-extraction jobs on the global memory permit,
/// so the lock can take tens of seconds to appear. Poll instead of a fixed
/// short sleep.
const LOCK_POLL_TIMEOUT_SECS: u64 = 120;
const LOCK_POLL_INTERVAL_SECS: u64 = 2;

fn seed_fake_sessions(workspace: &Path, count: usize) -> Result<(), String> {
    let session_dir = workspace.join(".orgii").join("sessions");
    std::fs::create_dir_all(&session_dir).map_err(|err| format!("mkdir sessions: {}", err))?;
    for idx in 0..count {
        let path = session_dir.join(format!("fake-session-{idx}.jsonl"));
        std::fs::write(&path, "{\"role\":\"user\",\"content\":\"seed\"}\n")
            .map_err(|err| format!("write fake session: {}", err))?;
    }
    Ok(())
}

fn seed_initial_memory(workspace: &Path) -> Result<(), String> {
    let mem_dir = workspace.join(".orgii").join("workspace-memory");
    std::fs::create_dir_all(&mem_dir).map_err(|err| format!("mkdir mem: {}", err))?;

    let topic = "\
---
name: Initial Note
description: A small pre-existing memory to give auto-dream something to read
type: workspace
---

This project uses Bazel with remote caching. Build targets follow `//src/{module}:target`.
";
    std::fs::write(mem_dir.join("initial_note.md"), topic)
        .map_err(|err| format!("write topic: {}", err))?;

    let index = "- [Initial Note](initial_note.md) — Bazel + remote caching\n";
    std::fs::write(mem_dir.join("MEMORY.md"), index)
        .map_err(|err| format!("write index: {}", err))?;
    Ok(())
}

/// Verify auto-dream triggers via the production config path: flipping
/// `learnings.auto_dream_enabled` on the `builtin:sde` agent definition
/// via `/agent/test/agent-config/set`.
///
/// This scenario mutates the agent definition overlay that
/// `ResolvedAgent::resolve` consumes on every session init.
/// If the resolver → processor wiring regresses, the
/// `.consolidate-lock` file never appears.
///
/// Teardown resets the overlay so subsequent scenarios see the
/// compiled-in default again (test isolation: compiled-in default).
pub async fn auto_dream_from_config(cfg: &Config) -> bool {
    const AGENT_ID: &str = "builtin:sde";

    let session_id = format!("{}-dream-cfg", cfg.session_prefix);
    let project = tmp_workspace_path("dream-cfg");
    let workspace = Path::new(&project);
    let mem_dir = workspace.join(".orgii").join("workspace-memory");
    let lock_path = mem_dir.join(".consolidate-lock");

    let _ = std::fs::remove_dir_all(workspace.join(".orgii"));

    println!("  [step 1] Flipping {AGENT_ID}.learnings.auto_dream_enabled=true via /agent/test/agent-config/set...");
    let patch = serde_json::json!({
        "agent_id": AGENT_ID,
        "auto_dream_enabled": true,
    });
    let applied = harness::set_agent_config(cfg, patch).await;
    let overlay_applied = applied
        .as_ref()
        .ok()
        .and_then(|v| v.get("auto_dream_enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if let Err(ref err) = applied {
        println!("  [warn] overlay set failed: {err}");
    }

    println!("  [step 2] Seeding {MIN_SESSIONS} fake session files + initial memory...");
    if let Err(err) = seed_fake_sessions(workspace, MIN_SESSIONS) {
        harness::reset_agent_config(cfg, AGENT_ID).await;
        return harness::print_error("Auto-Dream From Config", &err);
    }
    if let Err(err) = seed_initial_memory(workspace) {
        harness::reset_agent_config(cfg, AGENT_ID).await;
        return harness::print_error("Auto-Dream From Config", &err);
    }

    println!(
        "  [step 3] Sending SDE turn with no HTTP flag (resolver must pick up the overlay)..."
    );
    let resp = harness::send_sde_message(
        cfg,
        "Acknowledge this turn briefly. No tool calls needed.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let turn_ok = resp.is_ok();
    if let Err(ref err) = resp {
        println!("  [warn] turn failed: {err}");
    }

    println!(
        "  [step 4] Polling up to {LOCK_POLL_TIMEOUT_SECS}s for the coordinator-queued auto-dream..."
    );
    let poll_deadline = std::time::Instant::now() + Duration::from_secs(LOCK_POLL_TIMEOUT_SECS);
    while !lock_path.exists() && std::time::Instant::now() < poll_deadline {
        tokio::time::sleep(Duration::from_secs(LOCK_POLL_INTERVAL_SECS)).await;
    }

    let lock_exists = lock_path.exists();
    // Same reasoning as the first assertion site: surface read
    // failure on an existing lock file so the test doesn't pass
    // when the lock exists but is unreadable.
    let lock_body = if lock_exists {
        match std::fs::read_to_string(&lock_path) {
            Ok(s) => s,
            Err(err) => {
                println!(
                    "  [warn] lock file exists but read failed: {} ({err})",
                    lock_path.display()
                );
                String::new()
            }
        }
    } else {
        String::new()
    };
    let lock_has_pid = lock_body.trim().parse::<u32>().is_ok();
    let memory_md_exists = mem_dir.join("MEMORY.md").exists();

    let _ = std::fs::remove_dir_all(workspace.join(".orgii"));
    harness::reset_agent_config(cfg, AGENT_ID).await;

    let summary = format!(
        "overlay_applied={overlay_applied} lock_exists={lock_exists} lock_body={:?} memory_md_exists={memory_md_exists}",
        lock_body.trim()
    );

    harness::print_result(
        "Auto-Dream From Config",
        &summary,
        &[
            ("Overlay applied via agent-config/set", overlay_applied),
            ("SDE turn succeeded", turn_ok),
            (".consolidate-lock created (config path)", lock_exists),
            (".consolidate-lock body is a PID", lock_has_pid),
            ("MEMORY.md survives consolidation", memory_md_exists),
        ],
    )
}
