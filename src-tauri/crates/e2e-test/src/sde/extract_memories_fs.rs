//! State-level assertions for L2 extract-memories runtime contracts.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::config::Config;
use crate::harness::{self, SdeMessageOpts};

use super::tmp_workspace_path;

const WAIT_AFTER_TURN_SECS: u64 = 60;
const POLL_INTERVAL_MS: u64 = 500;

fn collect_memory_md_files(mem_dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(read) = std::fs::read_dir(mem_dir) else {
        return out;
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "md").unwrap_or(false) {
            // Skip the MEMORY.md index — we only want topic files.
            if path.file_name().map(|n| n == "MEMORY.md").unwrap_or(false) {
                continue;
            }
            out.push(path);
        }
    }
    out
}

// ============================================
// Tool-heavy regression pin for extract_memories gate
// ============================================
//
// This scenario is the regression pin for the `count_new_messages` bug
// (bug now fixed): the old implementation only counted messages with
// role ∈ {user, assistant}, which meant a 1-turn SDE exchange with
// tool_use / tool_result blocks (the common case) never reached
// `MIN_NEW_MESSAGES = 2` and the gate silently rejected the extractor
// every time — L2 workspace-memory just stopped working.
//
// To pin it, we force a tool-heavy SDE turn: the prompt includes a
// concrete code-navigation task ("list this directory + read the README")
// that reliably drives at least one `list_dir` or `read_file` tool_use
// on every run. Then we assert BOTH:
//   1. `tool_calls_count >= 1` (the turn was actually tool-heavy)
//   2. A memory file appeared under `.orgii/workspace-memory/` within 60s
//
// If assertion 1 passes but 2 fails, the gate has regressed — a tool-heavy
// turn is reaching the processor but `count_new_messages` is dropping
// tool_use / tool_result frames and the gate is rejecting again.

pub async fn extract_memories_tool_heavy(cfg: &Config) -> bool {
    let session_id = format!("{}-extract-mem-tools", cfg.session_prefix);
    let project = tmp_workspace_path("extract-mem-tools");
    let workspace = Path::new(&project);
    let orgii_dir = workspace.join(".orgii");
    let mem_dir = orgii_dir.join("workspace-memory");

    let _ = std::fs::remove_dir_all(&orgii_dir);

    // Seed a README.md in the workspace so the agent has something real
    // to list / read. Using a stable file with a durable convention
    // also gives the extractor something memorable to distill.
    let readme = workspace.join("README.md");
    if let Err(err) = std::fs::write(
        &readme,
        "# Tool-Heavy Extract Memory Test\n\n\
         This repo uses Bazel, not Cargo, for all Rust builds. When you edit \
         any Rust crate, you MUST run `bazel build //src/...` instead of \
         `cargo build` — Cargo skips the monorepo cache and CI rejects \
         artifacts built that way.\n",
    ) {
        return harness::print_error(
            "Extract Memories Tool Heavy",
            &format!("seed README: {err}"),
        );
    }

    // Prompt is framed as a code-navigation task, which reliably forces
    // the agent through `list_dir` and/or `read_file` before it can
    // answer. This guarantees tool_use / tool_result frames in the
    // transcript — the exact shape the old `count_new_messages` bug
    // mishandled.
    let prompt = "I just opened this repo and I want to understand its \
         build conventions before I touch any code. List this directory \
         and read any README/BUILD notes you find, then briefly tell me \
         how builds work here. Keep your final answer to 2–3 sentences.";

    println!("  [step 1] Sending tool-heavy SDE turn (no_cleanup=true)...");
    // Keep the session alive so the debug em-state endpoint can read
    // the shared `ExtractMemoriesState` after the background fork
    // finishes. The assertion on `last_processed_seq` is the most
    // reliable signal that the gate actually cleared — it is only
    // written by `run_extraction` on success, so if the fork was
    // skipped (bug 1 regression: `count_new_messages` under-counting
    // tool frames), the cursor stays `None`.
    let opts = SdeMessageOpts {
        enable_extract_memories: true,
        no_cleanup: true,
        ..Default::default()
    };
    let resp =
        harness::send_sde_message_with_opts(cfg, prompt, &session_id, "build", &project, &opts)
            .await;

    let turn_ok = resp.is_ok();
    let tool_call_count = resp
        .as_ref()
        .ok()
        .and_then(|r| r.tool_calls_count)
        .unwrap_or(0);
    let tool_names_joined = resp
        .as_ref()
        .ok()
        .map(|r| r.tool_calls.join(","))
        .unwrap_or_default();
    if let Err(ref err) = resp {
        println!("  [warn] turn failed: {err}");
    }
    println!(
        "  [info] tool_calls_count={} names=[{}]",
        tool_call_count, tool_names_joined
    );

    // Poll the em-state endpoint until the cursor advances OR the
    // deadline hits. The fork itself is fire-and-forget on a tokio
    // task, so we cannot rely on the turn response to signal
    // completion; we have to sample the shared state instead.
    println!(
        "  [step 2] Polling up to {WAIT_AFTER_TURN_SECS}s for extract fork to advance em_state cursor..."
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

    // Diagnostic only: count memory files actually written by the
    // fork. The fork's inner LLM loop is non-deterministic (it may
    // emit valid `edit_file` calls or it may only touch `MEMORY.md`),
    // so this number is not a pass/fail gate — we only use it as a
    // debugging hint when investigating failures.
    let files = collect_memory_md_files(&mem_dir);
    let file_count = files.len();

    let (cursor_advanced, not_in_progress, snap_repr) = match last_snapshot.as_ref() {
        Some(snap) => {
            let cursor_advanced = snap.last_processed_seq.is_some();
            let not_in_progress = !snap.in_progress;
            let repr = format!(
                "last_processed_seq={:?} in_progress={} turns_since_extraction={}",
                snap.last_processed_seq, snap.in_progress, snap.turns_since_extraction,
            );
            (cursor_advanced, not_in_progress, repr)
        }
        None => (false, false, "em_state fetch never succeeded".to_string()),
    };

    let _ = harness::cleanup_sde_session(cfg, &session_id).await;
    let _ = std::fs::remove_file(&readme);
    let _ = std::fs::remove_dir_all(&orgii_dir);

    let summary = format!(
        "turn_ok={turn_ok} tool_calls_count={tool_call_count} memory_files={file_count} {snap_repr}"
    );

    harness::print_result(
        "Extract Memories Tool Heavy",
        &summary,
        &[
            ("SDE turn succeeded", turn_ok),
            (
                "Turn was actually tool-heavy (count_new_messages regression pin)",
                tool_call_count >= 1,
            ),
            (
                "Extract fork cleared the MIN_NEW_MESSAGES gate and advanced em_state cursor",
                cursor_advanced,
            ),
            (
                "Fork's overlap guard is not stuck in_progress",
                not_in_progress,
            ),
        ],
    )
}

// ============================================
// Main-agent mutual exclusion path
// ============================================
//
// This scenario pins `skip_if_main_agent_wrote_memory`: when the main
// agent itself writes a file under `.orgii/workspace-memory/` in the same
// turn, the background extractor must NOT run (and must NOT overwrite
// the main agent's content). Implemented as a hard skip to keep the
// fork and the main agent from racing on the same file.
//
// We force the main agent to create a stable, clearly-worded memory
// file. Then we record the file's mtime and content, wait 60s (more
// than enough for any extract fork to land), and assert:
//   1. The file still exists
//   2. mtime has NOT advanced since the main agent wrote it
//   3. The unique marker we asked the main agent to write is still in
//      the body (not replaced by extractor-generated wording)

// ============================================
// Cross-turn em_state persistence pin
// ============================================
//
// Regression pin for the em_state persistence bug: before the fix,
// `integration::process_message` rebuilt `UnifiedMessageProcessor` on
// every turn and constructed a fresh `ExtractMemoriesState::default()`
// each time, so `last_processed_seq`, `in_progress`, and
// `turns_since_extraction` never
// carried over. The gating / throttle / overlap logic all appeared to
// work in isolation (unit tests passed) but was effectively disabled
// at runtime.
//
// After the fix, `AgentSession` owns
// `em_state: Arc<Mutex<ExtractMemoriesState>>` and the processor
// reads it directly from `Arc<AgentSession>`, so the cursor
// advances across turns.
//
// This scenario:
//   1. Sends two tool-heavy SDE turns in the same session, keeping
//      the session alive between them (`no_cleanup=true` on turn 1).
//   2. Reads `GET /agent/test/em-state/:session_id` after turn 2 (also
//      kept alive) and asserts that `last_processed_seq` has advanced
//      past zero.
//   3. Asserts `in_progress == false` (no orphaned overlap guard) and
//      sanity-checks `turns_since_extraction`.
//
// Before the fix: `last_processed_seq` would come back as `None` every
// turn because the state object was freshly-defaulted. After the fix:
// the cursor is whatever the last extraction landed at.

pub async fn extract_memories_cursor_advances(cfg: &Config) -> bool {
    let session_id = format!("{}-extract-mem-cursor", cfg.session_prefix);
    let project = tmp_workspace_path("extract-mem-cursor");
    let workspace = Path::new(&project);
    let orgii_dir = workspace.join(".orgii");

    let _ = std::fs::remove_dir_all(&orgii_dir);

    let readme = workspace.join("README.md");
    if let Err(err) = std::fs::write(
        &readme,
        "# Cursor Advance Test\n\n\
         This workspace exercises the cross-turn em_state persistence pin. \
         The repo uses Bazel and enforces a strict bazel-only build policy.\n",
    ) {
        return harness::print_error(
            "Extract Memories Cursor Advances",
            &format!("seed README: {err}"),
        );
    }

    // Turn 1: tool-heavy intro that drives list_dir / read_file.
    // `no_cleanup=true` keeps the session runtime alive so turn 2 hits
    // the same `AgentSession` and thus the same `em_state` handle.
    let prompt_1 = "List this directory and read the README. Briefly tell me \
         what build tool this repo uses. Keep it to one sentence.";
    let opts_keepalive = SdeMessageOpts {
        enable_extract_memories: true,
        no_cleanup: true,
        ..Default::default()
    };

    println!("  [step 1] Sending tool-heavy turn 1 (no_cleanup=true)...");
    let resp_1 = harness::send_sde_message_with_opts(
        cfg,
        prompt_1,
        &session_id,
        "build",
        &project,
        &opts_keepalive,
    )
    .await;
    let turn1_ok = resp_1.is_ok();
    let turn1_tool_calls = resp_1
        .as_ref()
        .ok()
        .and_then(|r| r.tool_calls_count)
        .unwrap_or(0);
    if let Err(ref err) = resp_1 {
        println!("  [warn] turn 1 failed: {err}");
    }
    println!("  [info] turn1_ok={turn1_ok} turn1_tool_calls={turn1_tool_calls}");

    // Let the coordinator-owned extract fork land and advance the cursor
    // before turn 2 — a new turn cancels an in-flight extraction, so poll
    // until the fork is done instead of sleeping a fixed interval.
    let fork_deadline = std::time::Instant::now() + Duration::from_secs(90);
    while std::time::Instant::now() < fork_deadline {
        match harness::fetch_em_state(cfg, &session_id).await {
            Ok(snap) if !snap.in_progress && snap.last_processed_seq.is_some() => break,
            _ => tokio::time::sleep(Duration::from_secs(2)).await,
        }
    }

    // Turn 2: another tool-heavy exchange, also no_cleanup=true so the
    // em-state endpoint can still see the session afterwards.
    let prompt_2 = "Now list the directory again and confirm the README is \
         still there. One sentence answer.";

    println!("  [step 2] Sending tool-heavy turn 2 (no_cleanup=true)...");
    let resp_2 = harness::send_sde_message_with_opts(
        cfg,
        prompt_2,
        &session_id,
        "build",
        &project,
        &opts_keepalive,
    )
    .await;
    let turn2_ok = resp_2.is_ok();
    let turn2_tool_calls = resp_2
        .as_ref()
        .ok()
        .and_then(|r| r.tool_calls_count)
        .unwrap_or(0);
    if let Err(ref err) = resp_2 {
        println!("  [warn] turn 2 failed: {err}");
    }
    println!("  [info] turn2_ok={turn2_ok} turn2_tool_calls={turn2_tool_calls}");

    // Poll the em-state endpoint — the fork holds the global processor
    // mutex while running, so a one-shot fetch can race with the lock
    // and time out. Retry until the cursor advances or we hit the
    // deadline. Same shape as the tool-heavy scenario.
    println!("  [step 3] Polling em_state via debug endpoint...");
    let deadline = std::time::Instant::now() + Duration::from_secs(WAIT_AFTER_TURN_SECS);
    let em: Result<harness::EmStateSnapshot, String> = loop {
        match harness::fetch_em_state(cfg, &session_id).await {
            Ok(snap) => {
                if snap.last_processed_seq.is_some() {
                    break Ok(snap);
                }
                if std::time::Instant::now() >= deadline {
                    break Ok(snap);
                }
            }
            Err(err) => {
                println!("  [warn] fetch_em_state transient error: {err}");
                if std::time::Instant::now() >= deadline {
                    break Err(err);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
    };
    if let Err(ref err) = em {
        println!("  [warn] fetch_em_state final error: {err}");
    }

    // Primary assertion: `last_processed_seq` must have been
    // advanced past `None`. This is the most reliable
    // cross-turn persistence signal in the current code shape:
    //
    //   - Before the fix, every turn rebuilt `UnifiedMessageProcessor`
    //     with a fresh `ExtractMemoriesState::default()`, so
    //     `last_processed_seq` was `None` every turn the debug
    //     endpoint observed it.
    //   - After the fix, `AgentSession` owns the `Arc<Mutex<…>>` and
    //     the background extract fork spawned by turn 1 writes back
    //     the end-of-transcript sequence cursor into that
    //     shared state. Turn 2 (and the debug endpoint) then see a
    //     `Some(_)` cursor.
    //
    // We deliberately DO NOT assert on `turns_since_extraction` — the
    // throttle is effectively disabled (`EXTRACTION_INTERVAL = 1` so
    // `should_run` is always true once MIN_NEW_MESSAGES is met), and
    // `record_turn` only runs in the `else` branch, so that counter
    // stays 0 in tool-heavy scenarios like this one. It is not a
    // reliable persistence signal in practice.
    let (cursor_advanced, not_in_progress, snap_repr) = match em.as_ref() {
        Ok(snap) => {
            let cursor_advanced = snap.last_processed_seq.is_some();
            let not_in_progress = !snap.in_progress;
            let repr = format!(
                "last_processed_seq={:?} in_progress={} turns_since_extraction={}",
                snap.last_processed_seq, snap.in_progress, snap.turns_since_extraction,
            );
            (cursor_advanced, not_in_progress, repr)
        }
        Err(_) => (false, false, "em_state fetch failed".to_string()),
    };

    // Final cleanup: tear down the preserved session explicitly so we
    // don't leave a runtime hanging around for subsequent scenarios.
    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    let _ = std::fs::remove_file(&readme);
    let _ = std::fs::remove_dir_all(&orgii_dir);

    harness::print_result(
        "Extract Memories Cursor Advances",
        &snap_repr,
        &[
            ("Turn 1 succeeded", turn1_ok),
            ("Turn 1 was tool-heavy", turn1_tool_calls >= 1),
            ("Turn 2 succeeded", turn2_ok),
            ("Turn 2 was tool-heavy", turn2_tool_calls >= 1),
            ("em_state fetch returned ok", em.is_ok()),
            (
                "last_processed_seq advanced past None (state persists across turns)",
                cursor_advanced,
            ),
            (
                "in_progress is false (no orphaned overlap guard)",
                not_in_progress,
            ),
        ],
    )
}

const MUTUAL_EXCLUSION_MARKER: &str = "MUTUAL_EXCLUSION_TEST_MARKER_2104";

pub async fn extract_memories_main_agent_wrote(cfg: &Config) -> bool {
    let session_id = format!("{}-extract-mem-main", cfg.session_prefix);
    let project = tmp_workspace_path("extract-mem-main");
    let workspace = Path::new(&project);
    let orgii_dir = workspace.join(".orgii");
    let mem_dir = orgii_dir.join("workspace-memory");

    let _ = std::fs::remove_dir_all(&orgii_dir);

    // Prompt the main agent to explicitly write a workspace-memory file.
    // The unique marker embedded here is the only way we can later tell
    // "this is what the main agent wrote" from "this is what the
    // extractor wrote". If mutual exclusion fails, the extractor's
    // re-write will not contain the marker.
    let prompt = format!(
        "Please create a new file at `.orgii/workspace-memory/build_conventions.md` \
         (you may need to mkdir the parent directories). The file should contain:\n\n\
         ---\ntype: workspace\n---\n\n\
         # Build Conventions\n\n\
         This repo uses Bazel exclusively. {MUTUAL_EXCLUSION_MARKER}\n\n\
         Write exactly that content, nothing else."
    );

    println!(
        "  [step 1] Asking main agent to write .orgii/workspace-memory/build_conventions.md..."
    );
    let opts = SdeMessageOpts {
        enable_extract_memories: true,
        no_cleanup: false,
        ..Default::default()
    };
    let resp =
        harness::send_sde_message_with_opts(cfg, &prompt, &session_id, "build", &project, &opts)
            .await;

    let turn_ok = resp.is_ok();
    let used_edit = resp
        .as_ref()
        .map(|r| harness::assert_sde_tool_used(r, "edit_file"))
        .unwrap_or(false);
    if let Err(ref err) = resp {
        println!("  [warn] turn failed: {err}");
    }

    let target = mem_dir.join("build_conventions.md");

    // Poll briefly to let fs settle.
    for _ in 0..10 {
        if target.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // A silent empty content here would make `main_wrote = false`
    // and `main_marker_present = false` for both "file genuinely
    // doesn't exist" and "file exists but read failed" — allowing
    // the mutual-exclusion test to falsely conclude the main
    // agent didn't write when in fact we just couldn't read it.
    // Surface the read failure so the runner can inspect the root cause.
    let initial_content = if target.exists() {
        match std::fs::read_to_string(&target) {
            Ok(s) => s,
            Err(err) => {
                println!(
                    "  [warn] target exists but read failed: {} ({err})",
                    target.display()
                );
                String::new()
            }
        }
    } else {
        String::new()
    };
    let initial_mtime = std::fs::metadata(&target).and_then(|m| m.modified()).ok();
    let main_wrote = !initial_content.is_empty();
    let main_marker_present = initial_content.contains(MUTUAL_EXCLUSION_MARKER);

    println!(
        "  [step 2] Main agent wrote={} marker_present={} initial_len={}",
        main_wrote,
        main_marker_present,
        initial_content.len()
    );

    // Now wait long enough for an extract fork to finish, if it were
    // going to run. If mutual exclusion is working, it never runs at
    // all; if it's broken, the fork will overwrite with its own
    // wording and the marker disappears.
    println!(
        "  [step 3] Waiting {WAIT_AFTER_TURN_SECS}s to see if extract fork overwrites the file..."
    );
    tokio::time::sleep(Duration::from_secs(WAIT_AFTER_TURN_SECS)).await;

    // Same reasoning as the initial-content read: surface read
    // failure so the mutual-exclusion check can't pass-by-default
    // on an unreadable target.
    let final_content = if target.exists() {
        match std::fs::read_to_string(&target) {
            Ok(s) => s,
            Err(err) => {
                println!(
                    "  [warn] target exists but final read failed: {} ({err})",
                    target.display()
                );
                String::new()
            }
        }
    } else {
        String::new()
    };
    let final_mtime = std::fs::metadata(&target).and_then(|m| m.modified()).ok();
    let final_marker_present = final_content.contains(MUTUAL_EXCLUSION_MARKER);
    let mtime_unchanged = matches!(
        (initial_mtime, final_mtime),
        (Some(a), Some(b)) if a == b
    );

    let _ = std::fs::remove_dir_all(&orgii_dir);

    let summary = format!(
        "turn_ok={turn_ok} used_edit={used_edit} main_wrote={main_wrote} marker_final={final_marker_present} mtime_unchanged={mtime_unchanged}"
    );

    harness::print_result(
        "Extract Memories Main Agent Wrote",
        &summary,
        &[
            ("SDE turn succeeded", turn_ok),
            ("Main agent used edit_file", used_edit),
            ("Main agent actually wrote the target file", main_wrote),
            (
                "Main agent's marker is in initial content",
                main_marker_present,
            ),
            (
                "Marker survived (extract fork did NOT overwrite)",
                final_marker_present,
            ),
            (
                "File mtime did NOT advance after main write (no fork overwrite)",
                mtime_unchanged,
            ),
        ],
    )
}
