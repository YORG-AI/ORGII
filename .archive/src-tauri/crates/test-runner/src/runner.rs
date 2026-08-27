use crate::detection::get_test_command;
use crate::types::*;
use regex::Regex;
/**
 * Test Runner
 *
 * Executes tests and parses output from various test frameworks.
 * Emits streaming events to the frontend via Tauri events.
 */
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

/// Run tests and stream results
pub async fn run_tests(
    app: AppHandle,
    workspace_path: &Path,
    framework: TestFramework,
    test_ids: Option<Vec<String>>,
) -> Result<TestRunSummary, String> {
    tracing::info!(
        framework = ?framework,
        project = %workspace_path.display(),
        test_ids = ?test_ids,
        "[TestRunner] Running tests"
    );

    let run_id = uuid::Uuid::new_v4().to_string();
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

    // Emit run started
    let _ = app.emit(
        "test-event",
        TestEvent::RunStarted {
            run_id: run_id.clone(),
            total_tests: 0,
        },
    );

    // Spawn process
    tracing::info!(
        command = %cmd,
        args = ?args,
        cwd = %workspace_path.display(),
        "[TestRunner] Spawning process"
    );
    let mut child = Command::new(cmd)
        .args(&args)
        .current_dir(workspace_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let error_msg = format!("Failed to spawn test process: {}", e);
            tracing::error!(error = %error_msg, "[TestRunner] Failed to spawn process");
            error_msg
        })?;

    tracing::info!("[TestRunner] Process spawned successfully, reading output");

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Read stdout and stderr
    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    let mut stdout_lines = stdout_reader.lines();
    let mut stderr_lines = stderr_reader.lines();

    let mut stdout_output = String::new();
    let mut stderr_output = String::new();

    // Read stdout
    while let Ok(Some(line)) = stdout_lines.next_line().await {
        stdout_output.push_str(&line);
        stdout_output.push('\n');
    }

    // Read stderr
    while let Ok(Some(line)) = stderr_lines.next_line().await {
        stderr_output.push_str(&line);
        stderr_output.push('\n');
    }

    // Wait for process
    let status = child
        .wait()
        .await
        .map_err(|e| format!("Test process failed: {}", e))?;

    let duration_ms = start_time.elapsed().as_millis() as u64;
    let finished_at = chrono::Utc::now().to_rfc3339();

    tracing::info!(
        exit_code = ?status.code(),
        stdout_bytes = stdout_output.len(),
        stderr_bytes = stderr_output.len(),
        "[TestRunner] Process finished"
    );
    if !stdout_output.is_empty() {
        tracing::debug!(stdout = %stdout_output, "[TestRunner] Captured stdout");
    }
    if !stderr_output.is_empty() {
        tracing::debug!(stderr = %stderr_output, "[TestRunner] Captured stderr");
    }

    // Parse output based on framework
    let results = parse_test_output(&stdout_output, &stderr_output, &framework);

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
        let _ = app.emit(
            "test-event",
            TestEvent::TestFinished {
                result: result.clone(),
            },
        );
    }

    // If no results parsed but command failed, treat as error
    if results.is_empty() && !status.success() {
        let _ = app.emit(
            "test-event",
            TestEvent::Error {
                message: format!("Test command failed: {}", stderr_output),
            },
        );
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
    };

    // Emit run finished
    let _ = app.emit(
        "test-event",
        TestEvent::RunFinished {
            summary: summary.clone(),
        },
    );

    Ok(summary)
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
