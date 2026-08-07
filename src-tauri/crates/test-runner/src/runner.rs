use crate::capture::{capture_stream, CapturedOutput};
use crate::detection::get_test_command;
use crate::types::*;
use regex::Regex;
/**
 * Test Runner
 *
 * Executes tests and parses output from various test frameworks.
 * Emits streaming events through the provided sink (the Tauri command
 * layer forwards them to the frontend as `test-event`).
 */
use std::path::Path;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

/// Per-stream capture budget. Big enough for the one-document JSON
/// reporters (Vitest/Jest/Mocha) on large suites; a stream beyond this is
/// tail-truncated so a runaway test process cannot grow app memory
/// without bound.
pub(crate) const MAX_CAPTURED_STREAM_BYTES: usize = 16 * 1024 * 1024;

/// Courtesy interval between SIGTERM and SIGKILL on cancellation. Kept
/// short: stopping tests should feel immediate, and test processes have no
/// state worth a long graceful shutdown.
const TERMINATE_GRACE: std::time::Duration = std::time::Duration::from_millis(300);

/// Event sink used by the runner. The command layer forwards each event to
/// the webview; tests can collect them directly.
pub type EventSink<'a> = &'a (dyn Fn(TestEvent) + Send + Sync);

/// Run tests and stream results.
///
/// `run_id` is the canonical identifier minted by the command layer: it is
/// stamped on every emitted event and on the returned summary, and it is
/// the key `stop_tests` uses to signal `cancel`.
pub async fn run_tests(
    run_id: String,
    workspace_path: &Path,
    framework: TestFramework,
    test_ids: Option<Vec<String>>,
    cancel: CancellationToken,
    emit: EventSink<'_>,
) -> Result<TestRunSummary, String> {
    tracing::info!(
        framework = ?framework,
        project = %workspace_path.display(),
        test_ids = ?test_ids,
        run_id = %run_id,
        "[TestRunner] Running tests"
    );

    let started_at = chrono::Utc::now().to_rfc3339();
    let start_time = std::time::Instant::now();

    // Get base command
    let (cmd, base_args) = get_test_command(&framework);
    let mut args: Vec<String> = base_args.iter().map(|s| s.to_string()).collect();

    tracing::info!(command = %cmd, args = ?args, "[TestRunner] Command resolved");

    // Add test file filters if specific tests requested
    if let Some(ref ids) = test_ids {
        match framework {
            TestFramework::Vitest => {
                // Vitest: add file paths directly
                for id in ids {
                    args.push(id.clone());
                }
            }
            TestFramework::Jest => {
                // Jest: use --testPathPattern
                if !ids.is_empty() {
                    args.push("--testPathPattern".to_string());
                    args.push(ids.join("|"));
                }
            }
            TestFramework::Pytest => {
                // Pytest: add file paths directly
                for id in ids {
                    args.push(id.clone());
                }
            }
            TestFramework::Cargo => {
                // Cargo: filter by test name
                for id in ids {
                    args.push(id.clone());
                }
            }
            _ => {}
        }
    }

    emit(TestEvent::RunStarted {
        run_id: run_id.clone(),
        total_tests: 0,
    });

    tracing::info!(
        command = %cmd,
        args = ?args,
        cwd = %workspace_path.display(),
        "[TestRunner] Spawning process"
    );

    let capture = run_command_capture(
        cmd,
        &args,
        workspace_path,
        &cancel,
        MAX_CAPTURED_STREAM_BYTES,
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "[TestRunner] Failed to run test process");
        emit(TestEvent::Error {
            message: error.clone(),
        });
        error
    })?;

    let duration_ms = start_time.elapsed().as_millis() as u64;
    let finished_at = chrono::Utc::now().to_rfc3339();

    tracing::info!(
        exit_code = ?capture.status.and_then(|status| status.code()),
        cancelled = capture.cancelled,
        stdout_bytes = capture.stdout.total_bytes,
        stderr_bytes = capture.stderr.total_bytes,
        stdout_truncated = capture.stdout.truncated,
        stderr_truncated = capture.stderr.truncated,
        "[TestRunner] Process finished"
    );

    // Parse output based on framework. On cancellation or truncation this
    // yields whatever completed tests are still visible in the tail.
    let results = parse_test_output(&capture.stdout.text, &capture.stderr.text, &framework);

    tracing::info!(
        result_count = results.len(),
        "[TestRunner] Parsed test results"
    );

    // Calculate summary
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut skipped = 0u32;

    for result in &results {
        match result.status {
            TestStatus::Passed => passed += 1,
            TestStatus::Failed | TestStatus::Errored => failed += 1,
            TestStatus::Skipped => skipped += 1,
            _ => {}
        }

        // Emit individual test result
        emit(TestEvent::TestFinished {
            result: result.clone(),
        });
    }

    let succeeded = capture.status.map(|s| s.success()).unwrap_or(false);

    // If no results parsed but command failed (and was not cancelled by the
    // user), surface the failure.
    if results.is_empty() && !succeeded && !capture.cancelled {
        emit(TestEvent::Error {
            message: format!(
                "Test command failed: {}",
                tail_of(&capture.stderr.text, 4096)
            ),
        });
    }

    let summary = TestRunSummary {
        run_id: run_id.clone(),
        framework,
        total: passed + failed + skipped,
        passed,
        failed,
        skipped,
        duration_ms,
        results,
        started_at,
        finished_at: Some(finished_at),
        cancelled: capture.cancelled,
    };

    if capture.cancelled {
        emit(TestEvent::RunCancelled {
            run_id: run_id.clone(),
        });
    } else {
        emit(TestEvent::RunFinished {
            summary: summary.clone(),
        });
    }

    Ok(summary)
}

/// Outcome of executing one test command to completion or cancellation.
#[derive(Debug)]
pub(crate) struct CommandCapture {
    /// Exit status. `None` only when the post-kill reap failed.
    pub status: Option<std::process::ExitStatus>,
    /// True when the run ended because `cancel` fired.
    pub cancelled: bool,
    pub stdout: CapturedOutput,
    pub stderr: CapturedOutput,
}

/// Spawn `cmd` and capture both output streams concurrently (bounded), until
/// the process exits or `cancel` fires — in which case the whole process
/// tree is terminated.
///
/// Concurrent consumption is load-bearing: reading the streams sequentially
/// deadlocks once the unread pipe's buffer fills while the child blocks
/// writing to it.
pub(crate) async fn run_command_capture(
    cmd: &str,
    args: &[String],
    cwd: &Path,
    cancel: &CancellationToken,
    max_stream_bytes: usize,
) -> Result<CommandCapture, String> {
    let mut command = Command::new(cmd);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Safety net: if this future is dropped (e.g. the invoking webview
        // reloads), the child must not outlive it.
        .kill_on_drop(true);

    // Own process group / hidden console so cancellation can terminate the
    // whole tree (npx → node → workers) and not just the wrapper.
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(app_platform::CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn test process: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let stdout_task = tokio::spawn(capture_stream(stdout, max_stream_bytes));
    let stderr_task = tokio::spawn(capture_stream(stderr, max_stream_bytes));

    let mut cancelled = false;
    let status = tokio::select! {
        status = child.wait() => {
            Some(status.map_err(|e| format!("Test process failed: {}", e))?)
        }
        _ = cancel.cancelled() => {
            cancelled = true;
            terminate_child_tree(&mut child).await
        }
    };

    // The child is gone (exited or killed), so both pipes hit EOF and the
    // capture tasks finish draining promptly.
    let stdout = stdout_task
        .await
        .map_err(|e| format!("stdout capture task failed: {}", e))?;
    let stderr = stderr_task
        .await
        .map_err(|e| format!("stderr capture task failed: {}", e))?;

    Ok(CommandCapture {
        status,
        cancelled,
        stdout,
        stderr,
    })
}

/// Terminate the child and every process in its group/tree, then reap it.
///
/// Unix: SIGTERM to the process group (the child is its own group leader),
/// a short grace, then SIGKILL to the group. The group signals are sent
/// while the leader is still unreaped, so the pgid cannot have been
/// recycled. Windows: `taskkill /T /F` walks the tree by parent PID.
async fn terminate_child_tree(child: &mut Child) -> Option<std::process::ExitStatus> {
    let pid = child.id();

    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            signal_process_group(pid, libc::SIGTERM);
            tokio::time::sleep(TERMINATE_GRACE).await;
            signal_process_group(pid, libc::SIGKILL);
        } else {
            // Already reaped elsewhere; nothing to signal.
            let _ = child.start_kill();
        }
        child.wait().await.ok()
    }

    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            let mut taskkill = Command::new("taskkill");
            taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
            // Suppress the console window `taskkill` would otherwise flash.
            taskkill.creation_flags(app_platform::CREATE_NO_WINDOW);
            let _ = taskkill.output().await;
        }
        let _ = child.start_kill();
        child.wait().await.ok()
    }
}

/// Send `signal` to the process group led by `pid`. The child was spawned
/// with `process_group(0)`, so its PID is also its PGID.
#[cfg(unix)]
fn signal_process_group(pid: u32, signal: libc::c_int) {
    // SAFETY: `libc::kill` is an FFI call with no Rust-side invariants; a
    // stale PID simply yields `ESRCH`, which is harmless.
    unsafe {
        libc::kill(-(pid as libc::pid_t), signal);
    }
}

/// Last `max_bytes` of `s`, adjusted forward to a UTF-8 boundary.
fn tail_of(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Parse test output based on framework
fn parse_test_output(stdout: &str, stderr: &str, framework: &TestFramework) -> Vec<TestResult> {
    match framework {
        TestFramework::Vitest => parse_vitest_output(stdout, stderr),
        TestFramework::Jest => parse_jest_output(stdout, stderr),
        TestFramework::Pytest => parse_pytest_output(stdout, stderr),
        TestFramework::Cargo => parse_cargo_output(stdout, stderr),
        TestFramework::Mocha => parse_mocha_output(stdout, stderr),
        TestFramework::Unknown => vec![],
    }
}

/// Parse Vitest JSON output
fn parse_vitest_output(stdout: &str, _stderr: &str) -> Vec<TestResult> {
    // Try to parse JSON output
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        return parse_vitest_json(&json);
    }

    // Fall back to line-by-line parsing for non-JSON output
    parse_vitest_lines(stdout)
}

fn parse_vitest_json(json: &serde_json::Value) -> Vec<TestResult> {
    let mut results = Vec::new();

    if let Some(test_results) = json.get("testResults").and_then(|v| v.as_array()) {
        for file_result in test_results {
            let file_path = file_result
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(assertions) = file_result
                .get("assertionResults")
                .and_then(|v| v.as_array())
            {
                for test in assertions {
                    let status_str = test
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let status = match status_str {
                        "passed" => TestStatus::Passed,
                        "failed" => TestStatus::Failed,
                        "skipped" | "pending" | "todo" => TestStatus::Skipped,
                        _ => TestStatus::Errored,
                    };

                    let test_name = test
                        .get("fullName")
                        .or_else(|| test.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();

                    let error_message = test
                        .get("failureMessages")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let duration_ms = test.get("duration").and_then(|v| v.as_u64());

                    results.push(TestResult {
                        test_id: test_name.clone(),
                        status,
                        duration_ms,
                        error_message,
                        expected: None,
                        actual: None,
                        stack_trace: None,
                        file_path: file_path.clone(),
                        line: None,
                    });
                }
            }
        }
    }

    results
}

fn parse_vitest_lines(output: &str) -> Vec<TestResult> {
    let mut results = Vec::new();

    // Pattern: ✓ test name (duration)
    // Pattern: ✕ test name
    // Pattern: ○ test name (skipped)
    let pass_re = Regex::new(r"✓\s+(.+?)(?:\s+\((\d+)(?:ms)?\))?$").ok();
    let fail_re = Regex::new(r"[✕×]\s+(.+)").ok();
    let skip_re = Regex::new(r"[○↓]\s+(.+)").ok();

    for line in output.lines() {
        let line = line.trim();

        if let Some(ref re) = pass_re {
            if let Some(caps) = re.captures(line) {
                let name = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                let duration = caps.get(2).and_then(|m| m.as_str().parse().ok());
                results.push(TestResult {
                    test_id: name.clone(),
                    status: TestStatus::Passed,
                    duration_ms: duration,
                    error_message: None,
                    expected: None,
                    actual: None,
                    stack_trace: None,
                    file_path: None,
                    line: None,
                });
            }
        }

        if let Some(ref re) = fail_re {
            if let Some(caps) = re.captures(line) {
                let name = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                results.push(TestResult {
                    test_id: name.clone(),
                    status: TestStatus::Failed,
                    duration_ms: None,
                    error_message: None,
                    expected: None,
                    actual: None,
                    stack_trace: None,
                    file_path: None,
                    line: None,
                });
            }
        }

        if let Some(ref re) = skip_re {
            if let Some(caps) = re.captures(line) {
                let name = caps
                    .get(1)
                    .map(|m| m.as_str().to_string())
                    .unwrap_or_default();
                results.push(TestResult {
                    test_id: name.clone(),
                    status: TestStatus::Skipped,
                    duration_ms: None,
                    error_message: None,
                    expected: None,
                    actual: None,
                    stack_trace: None,
                    file_path: None,
                    line: None,
                });
            }
        }
    }

    results
}

/// Parse Jest JSON output
fn parse_jest_output(stdout: &str, _stderr: &str) -> Vec<TestResult> {
    // Jest outputs JSON when --json flag is used
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        return parse_jest_json(&json);
    }

    // Fall back to line parsing
    parse_vitest_lines(stdout) // Jest and Vitest have similar output
}

fn parse_jest_json(json: &serde_json::Value) -> Vec<TestResult> {
    let mut results = Vec::new();

    if let Some(test_results) = json.get("testResults").and_then(|v| v.as_array()) {
        for file_result in test_results {
            let file_path = file_result
                .get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if let Some(assertions) = file_result
                .get("assertionResults")
                .and_then(|v| v.as_array())
            {
                for test in assertions {
                    let status_str = test
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let status = match status_str {
                        "passed" => TestStatus::Passed,
                        "failed" => TestStatus::Failed,
                        "skipped" | "pending" | "todo" => TestStatus::Skipped,
                        _ => TestStatus::Errored,
                    };

                    let test_name = test
                        .get("fullName")
                        .or_else(|| test.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();

                    let error_message = test
                        .get("failureMessages")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    // Jest includes location info with --testLocationInResults
                    let line = test
                        .get("location")
                        .and_then(|loc| loc.get("line"))
                        .and_then(|v| v.as_u64())
                        .map(|n| n as u32);

                    results.push(TestResult {
                        test_id: test_name.clone(),
                        status,
                        duration_ms: test.get("duration").and_then(|v| v.as_u64()),
                        error_message,
                        expected: None,
                        actual: None,
                        stack_trace: None,
                        file_path: file_path.clone(),
                        line,
                    });
                }
            }
        }
    }

    results
}

/// Parse pytest output
fn parse_pytest_output(stdout: &str, stderr: &str) -> Vec<TestResult> {
    let mut results = Vec::new();
    let output = format!("{}\n{}", stdout, stderr);

    // Pattern: test_file.py::test_name PASSED
    // Pattern: test_file.py::TestClass::test_name FAILED
    let test_re = Regex::new(r"(\S+\.py)::(\S+)\s+(PASSED|FAILED|SKIPPED|ERROR)").ok();

    if let Some(ref re) = test_re {
        for caps in re.captures_iter(&output) {
            let file_path = caps.get(1).map(|m| m.as_str().to_string());
            let test_name = caps
                .get(2)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let status_str = caps.get(3).map(|m| m.as_str()).unwrap_or("unknown");

            let status = match status_str {
                "PASSED" => TestStatus::Passed,
                "FAILED" => TestStatus::Failed,
                "SKIPPED" => TestStatus::Skipped,
                "ERROR" => TestStatus::Errored,
                _ => TestStatus::Errored,
            };

            results.push(TestResult {
                test_id: test_name.clone(),
                status,
                duration_ms: None,
                error_message: None,
                expected: None,
                actual: None,
                stack_trace: None,
                file_path,
                line: None,
            });
        }
    }

    results
}

/// Parse Cargo test output
fn parse_cargo_output(stdout: &str, stderr: &str) -> Vec<TestResult> {
    let mut results = Vec::new();
    let output = format!("{}\n{}", stdout, stderr);

    // Pattern: test module::test_name ... ok
    // Pattern: test module::test_name ... FAILED
    let test_re = Regex::new(r"test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)").ok();

    if let Some(ref re) = test_re {
        for caps in re.captures_iter(&output) {
            let test_name = caps
                .get(1)
                .map(|m| m.as_str().to_string())
                .unwrap_or_default();
            let status_str = caps.get(2).map(|m| m.as_str()).unwrap_or("unknown");

            let status = match status_str {
                "ok" => TestStatus::Passed,
                "FAILED" => TestStatus::Failed,
                "ignored" => TestStatus::Skipped,
                _ => TestStatus::Errored,
            };

            results.push(TestResult {
                test_id: test_name.clone(),
                status,
                duration_ms: None,
                error_message: None,
                expected: None,
                actual: None,
                stack_trace: None,
                file_path: None,
                line: None,
            });
        }
    }

    results
}

/// Parse Mocha JSON output
fn parse_mocha_output(stdout: &str, _stderr: &str) -> Vec<TestResult> {
    // Mocha with --reporter json outputs JSON
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(stdout) {
        return parse_mocha_json(&json);
    }

    vec![]
}

fn parse_mocha_json(json: &serde_json::Value) -> Vec<TestResult> {
    let mut results = Vec::new();

    // Parse passes
    if let Some(passes) = json.get("passes").and_then(|v| v.as_array()) {
        for test in passes {
            let title = test
                .get("fullTitle")
                .or_else(|| test.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            results.push(TestResult {
                test_id: title,
                status: TestStatus::Passed,
                duration_ms: test.get("duration").and_then(|v| v.as_u64()),
                error_message: None,
                expected: None,
                actual: None,
                stack_trace: None,
                file_path: test
                    .get("file")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                line: None,
            });
        }
    }

    // Parse failures
    if let Some(failures) = json.get("failures").and_then(|v| v.as_array()) {
        for test in failures {
            let title = test
                .get("fullTitle")
                .or_else(|| test.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            let error_message = test
                .get("err")
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let stack_trace = test
                .get("err")
                .and_then(|e| e.get("stack"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            results.push(TestResult {
                test_id: title,
                status: TestStatus::Failed,
                duration_ms: test.get("duration").and_then(|v| v.as_u64()),
                error_message,
                expected: None,
                actual: None,
                stack_trace,
                file_path: test
                    .get("file")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                line: None,
            });
        }
    }

    // Parse pending/skipped
    if let Some(pending) = json.get("pending").and_then(|v| v.as_array()) {
        for test in pending {
            let title = test
                .get("fullTitle")
                .or_else(|| test.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();

            results.push(TestResult {
                test_id: title,
                status: TestStatus::Skipped,
                duration_ms: None,
                error_message: None,
                expected: None,
                actual: None,
                stack_trace: None,
                file_path: test
                    .get("file")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                line: None,
            });
        }
    }

    results
}

#[cfg(test)]
#[path = "tests/runner_tests.rs"]
mod tests;
