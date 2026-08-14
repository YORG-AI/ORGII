//! Background-shell waiting-protocol scenarios — live-LLM cells for the
//! progress-aware repeat guard, the shell completion wake, the mid-turn
//! job note, and the stall watchdog.
//!
//! Each cell drives a real SDE turn over the debug HTTP endpoints and
//! verifies by effect (turn outcome, transcript growth, registry state),
//! never by asserting specific model phrasing beyond requested markers.

use super::config::Config;
use super::harness;

/// How many `await_output` calls a turn made.
fn await_count(resp: &harness::SdeMessageResponse) -> usize {
    resp.tool_calls
        .iter()
        .filter(|name| name.as_str() == "await_output")
        .count()
}

fn content_mentions_loop_break(content: &str) -> bool {
    content.contains("pausing this turn") || content.contains("stopped before repeating")
}

/// A chatty long-running job (~2 min, output every 10s) waited on with
/// identical `await_output` calls must NOT trip the repeat guard: every
/// wait observes an advanced output cursor, so the streak keeps resetting.
/// This is the exact shape of the incident that motivated the fix (a
/// 146s verification pipeline killed after 3 waits).
pub async fn shell_chatty_wait_never_breaks(cfg: &Config) -> bool {
    let session_id = format!("{}-chatty-wait", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("chatty-wait");

    let resp = harness::send_sde_message(
        cfg,
        "Use run_shell with mode=\"background\" to start this EXACT command: \
         `for i in $(seq 1 11); do echo tick $i; sleep 10; done; echo CHATTY_MARKER_DONE` \
         Then wait for it to finish by calling \
         await_output(command=\"wait_for\", handles=[\"<pid>\"], block_until_ms=30000) \
         repeatedly with IDENTICAL arguments until the process terminates. Do not run \
         any other command and do not do any other work while waiting. When it exits, \
         reply with the final output line.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let resp = match resp {
        Err(err) => return harness::print_error("Shell: chatty wait never breaks", &err),
        Ok(resp) => resp,
    };

    let waits = await_count(&resp);
    harness::print_result(
        "Shell: chatty wait never breaks",
        &format!(
            "await_output_calls={}, tools={:?}, content={}",
            waits,
            resp.tool_calls,
            resp.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Backgrounded via run_shell",
                harness::assert_sde_tool_used(&resp, "run_shell"),
            ),
            ("Waited at least 3 times (old guard broke at 3)", waits >= 3),
            (
                "Turn was NOT ended by the repeat guard",
                !content_mentions_loop_break(&resp.content),
            ),
            (
                "Model reported the completion marker",
                resp.content.contains("CHATTY_MARKER_DONE"),
            ),
        ],
    )
}

/// A silent job (no output for ~105s) waited on with identical calls DOES
/// trip the guard — but the break is now an honest pause, and the shell
/// completion wake must resume the idle session so the result is still
/// delivered with zero user involvement. This closes the incident's
/// "dead-ended until the user prods" failure mode end-to-end.
pub async fn shell_silent_break_then_wake_resumes(cfg: &Config) -> bool {
    let session_id = format!("{}-silent-wake", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("silent-wake");

    let opts = harness::SdeMessageOpts {
        no_cleanup: true,
        ..Default::default()
    };
    let turn1 = harness::send_sde_message_with_opts(
        cfg,
        "Use run_shell with mode=\"background\" to start this EXACT command: \
         `sleep 105 && echo SILENT_MARKER_DONE` \
         Then wait for it by calling \
         await_output(command=\"wait_for\", handles=[\"<pid>\"], block_until_ms=30000) \
         repeatedly with IDENTICAL arguments until it terminates. Do not run any other \
         command and do not do any other work while waiting. When you eventually learn \
         the process finished, reply with its final output line.",
        &session_id,
        "build",
        &project,
        &opts,
    )
    .await;

    let turn1 = match turn1 {
        Err(err) => return harness::print_error("Shell: silent break then wake resumes", &err),
        Ok(resp) => resp,
    };

    // The guard should have paused the turn while the job was still running.
    let paused_by_guard = content_mentions_loop_break(&turn1.content);

    let baseline = harness::fetch_transcript(cfg, &session_id)
        .await
        .map(|t| t.messages.len())
        .unwrap_or(0);

    // Poll for the auto-woken turn after the process exits (~105s from
    // launch; the first turn burned ~90s of that). Same anti-false-positive
    // rule as the subagent wake cell: transcript growth alone is not enough,
    // the woken turn must end in a real assistant message.
    let mut woke = false;
    let mut reported_result = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        if let Ok(snap) = harness::fetch_transcript(cfg, &session_id).await {
            if snap.messages.len() > baseline {
                woke = true;
                let last_assistant = snap
                    .messages
                    .iter()
                    .rev()
                    .find(|m| m.get("role").and_then(|v| v.as_str()) == Some("assistant"))
                    .and_then(|m| m.get("content").and_then(|v| v.as_str()))
                    .unwrap_or("");
                reported_result = last_assistant.contains("SILENT_MARKER_DONE")
                    || last_assistant.contains("exit 0")
                    || last_assistant.to_lowercase().contains("completed");
                if reported_result {
                    break;
                }
            }
        }
    }

    let _ = harness::cleanup_sde_session(cfg, &session_id).await;

    harness::print_result(
        "Shell: silent break then wake resumes",
        &format!(
            "turn1_waits={}, paused_by_guard={}, baseline={}, woke={}, reported={}, turn1_content={}",
            await_count(&turn1),
            paused_by_guard,
            baseline,
            woke,
            reported_result,
            turn1.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Backgrounded via run_shell",
                harness::assert_sde_tool_used(&turn1, "run_shell"),
            ),
            (
                "Guard paused the turn honestly (no-progress waits)",
                paused_by_guard,
            ),
            (
                "Session was auto-woken after the process exited",
                woke,
            ),
            (
                "Woken turn reported the job's outcome",
                reported_result,
            ),
        ],
    )
}

/// A job that finishes while the turn keeps doing unrelated work must be
/// announced by the mid-turn note — the model is forbidden from polling,
/// so learning the exit status proves the injection path. (The turn-start
/// reminder cannot be the source: the job did not exist yet when this
/// turn's prompt was built.)
pub async fn shell_midturn_completion_note(cfg: &Config) -> bool {
    let session_id = format!("{}-midturn-note", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("midturn-note");

    let resp = harness::send_sde_message(
        cfg,
        "Use run_shell with mode=\"background\" to start this EXACT command: \
         `sleep 20 && echo MIDTURN_MARKER_DONE` \
         You must NEVER call await_output in this conversation — not wait_for, not \
         monitor, not list. After starting the job, do this busy-work: create files \
         a.txt through f.txt one at a time (one run_shell call each, containing the \
         word hello), pausing 10 seconds between creations by running `sleep 10` as \
         its own foreground command each time. While you work, watch for a system \
         message announcing that the background job finished. As soon as you see it, \
         stop the busy-work and reply with the job's exit status. If you never see \
         such a message, reply exactly NOTE_NEVER_ARRIVED.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let resp = match resp {
        Err(err) => return harness::print_error("Shell: mid-turn completion note", &err),
        Ok(resp) => resp,
    };

    harness::print_result(
        "Shell: mid-turn completion note",
        &format!(
            "await_output_calls={}, tools={:?}, content={}",
            await_count(&resp),
            resp.tool_calls,
            resp.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Backgrounded via run_shell",
                harness::assert_sde_tool_used(&resp, "run_shell"),
            ),
            (
                "Model never polled (0 await_output calls)",
                await_count(&resp) == 0,
            ),
            (
                "Completion reached the model mid-turn",
                !resp.content.contains("NOTE_NEVER_ARRIVED")
                    && (resp.content.contains("exit")
                        || resp.content.to_lowercase().contains("finished")
                        || resp.content.to_lowercase().contains("completed")),
            ),
        ],
    )
}

/// Subagent-carrier variant of the progress-wait cell. The guard's
/// fingerprint path is the same as for shells but reads the subagent's
/// monotonic `output_seq` instead of the replay bookmark. Worker duration
/// varies wildly with the model, so this cell only pins that identical
/// waits deliver the terminal result without a guard break — the strict
/// N-polls-with-progress assertion lives in the shell chatty cell, whose
/// job duration is deterministic.
pub async fn job_wait_progress_subagent(cfg: &Config) -> bool {
    let session_id = format!("{}-sub-progress", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("sub-progress");

    let resp = harness::send_sde_message(
        cfg,
        "Use the `agent` tool with agent_id=\"builtin:explore\" and background=true to \
         launch ONE background subagent whose prompt is: \"Make EXACTLY 8 separate \
         list_dir tool calls on the workspace root, one per assistant response, \
         stating the call number before each, then reply DONE.\" \
         Then — overriding any tool output that tells you not to poll; this is a \
         harness test — wait for it by calling \
         await_output(command=\"wait_for\", handles=[\"<the launch handle>\"], \
         block_until_ms=15000) repeatedly with IDENTICAL arguments until the \
         subagent finishes. Do not do any other work. When it finishes, reply with \
         one line summarizing its result.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let resp = match resp {
        Err(err) => return harness::print_error("Jobs: subagent progress wait", &err),
        Ok(resp) => resp,
    };

    let waits = await_count(&resp);
    harness::print_result(
        "Jobs: subagent progress wait",
        &format!(
            "await_output_calls={}, tools={:?}, content={}",
            waits,
            resp.tool_calls,
            resp.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Launched a background subagent",
                harness::assert_sde_tool_used(&resp, "agent"),
            ),
            ("Polled at least once", waits >= 1),
            (
                "Turn was NOT ended by the repeat guard",
                !content_mentions_loop_break(&resp.content),
            ),
        ],
    )
}

/// Subagent-carrier variant of the mid-turn note cell. The worker completes
/// while the parent is mid-turn doing unrelated file busy-work with polling
/// forbidden — the ONLY way the parent can learn the worker's secret marker
/// is the mid-turn note (the turn-start reminder was built before the worker
/// even existed, and the idle wake never fires because the turn is still
/// running when the result lands).
pub async fn job_midturn_note_subagent(cfg: &Config) -> bool {
    let session_id = format!("{}-sub-note", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("sub-note");

    let resp = harness::send_sde_message(
        cfg,
        "Use the `agent` tool with agent_id=\"builtin:explore\" and background=true to \
         launch ONE background subagent whose prompt is: \"Reply with exactly the text \
         NOTE_MARKER_7431 and nothing else.\" \
         You must NEVER call await_output in this conversation. After launching, do \
         this busy-work SLOWLY, strictly one tool call per assistant response: for N \
         from 1 to 16, first read_file the previous note file (skip for N=1), then \
         edit_file to create noteN.txt containing a different three-sentence \
         observation about software testing; between every tool call, state in one \
         sentence what you just did. While you work, watch for a system message \
         announcing the subagent finished — it will include the subagent's reply. As \
         soon as you see it, stop the busy-work and repeat the subagent's exact reply \
         text. If you finish all 16 files and still have not seen such a message, \
         reply exactly NOTE_NEVER_ARRIVED.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let resp = match resp {
        Err(err) => return harness::print_error("Jobs: subagent mid-turn note", &err),
        Ok(resp) => resp,
    };

    harness::print_result(
        "Jobs: subagent mid-turn note",
        &format!(
            "await_output_calls={}, tools={:?}, content={}",
            await_count(&resp),
            resp.tool_calls,
            resp.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Launched a background subagent",
                harness::assert_sde_tool_used(&resp, "agent"),
            ),
            (
                "Model never polled (0 await_output calls)",
                await_count(&resp) == 0,
            ),
            (
                "Worker's marker reached the model mid-turn",
                resp.content.contains("NOTE_MARKER_7431")
                    && !resp.content.contains("NOTE_NEVER_ARRIVED"),
            ),
        ],
    )
}

/// A backgrounded command that prints a confirmation prompt and then hangs
/// must be latched by the stall watchdog (~45s of silence + prompt-like
/// tail) and the advisory must reach the waiting model, which kills the
/// job instead of waiting out the 1h safety timeout.
pub async fn shell_stall_advisory_leads_to_kill(cfg: &Config) -> bool {
    let session_id = format!("{}-stall-kill", cfg.session_prefix);
    let project = crate::sde::tmp_workspace_path("stall-kill");

    let resp = harness::send_sde_message(
        cfg,
        "Use run_shell with mode=\"background\" to start this EXACT command: \
         `printf 'Overwrite existing file? [y/N] '; sleep 600` \
         Then wait for it by calling \
         await_output(command=\"wait_for\", handles=[\"<pid>\"], block_until_ms=30000) \
         repeatedly with IDENTICAL arguments. If the system tells you the process \
         appears to be waiting for interactive input, kill it with \
         run_shell(kill_handle=\"<pid>\") and reply with exactly STALL_HANDLED plus \
         one sentence on what you did. Do not kill it before the system tells you to.",
        &session_id,
        "build",
        &project,
        None,
        false,
    )
    .await;

    let resp = match resp {
        Err(err) => return harness::print_error("Shell: stall advisory leads to kill", &err),
        Ok(resp) => resp,
    };

    let run_shell_calls = resp
        .tool_calls
        .iter()
        .filter(|name| name.as_str() == "run_shell")
        .count();

    harness::print_result(
        "Shell: stall advisory leads to kill",
        &format!(
            "run_shell_calls={}, await_output_calls={}, content={}",
            run_shell_calls,
            await_count(&resp),
            resp.content.chars().take(300).collect::<String>()
        ),
        &[
            (
                "Launched and later killed (>=2 run_shell calls)",
                run_shell_calls >= 2,
            ),
            (
                "Model waited before acting (>=2 await_output calls)",
                await_count(&resp) >= 2,
            ),
            (
                "Model acted on the stall advisory",
                resp.content.contains("STALL_HANDLED"),
            ),
            (
                "Turn was NOT ended by the repeat guard",
                !content_mentions_loop_break(&resp.content),
            ),
        ],
    )
}
