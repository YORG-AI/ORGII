//! Tauri command handlers for the test runner.

use crate::detection;
use crate::discovery;
use crate::runner;
use crate::types::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

/// Registry of in-flight test runs, keyed by the canonical `run_id`.
///
/// `run_tests` mints one `run_id` per command invocation, registers it here
/// *before* any event is emitted, and hands the same id to the runner — so
/// the id the frontend sees on `run_started` is always a valid key for
/// `stop_tests`. Entries are removed when the run future completes (or is
/// dropped), so the map never retains terminal runs.
pub struct TestRunnerState {
    running: Mutex<HashMap<String, CancellationToken>>,
}

impl TestRunnerState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }

    /// Register a new run and return the token the runner must observe.
    fn begin(&self, run_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.lock().insert(run_id.to_string(), token.clone());
        token
    }

    /// Remove a run from the registry once its future settles.
    fn finish(&self, run_id: &str) {
        self.lock().remove(run_id);
    }

    /// Signal cancellation for `run_id`. Returns `true` when an active run
    /// was found and signalled, `false` when it already finished — a benign
    /// race for callers, not an error.
    fn request_stop(&self, run_id: &str) -> bool {
        match self.lock().get(run_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CancellationToken>> {
        self.running
            .lock()
            .expect("test runner state lock poisoned")
    }

    #[cfg(test)]
    fn active_runs(&self) -> usize {
        self.lock().len()
    }
}

impl Default for TestRunnerState {
    fn default() -> Self {
        Self::new()
    }
}

/// Deregisters a run when the `run_tests` future settles — including when
/// Tauri drops the future because the invoking webview went away.
struct RunGuard<'a> {
    state: &'a TestRunnerState,
    run_id: &'a str,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.state.finish(self.run_id);
    }
}

/// Detect test framework in a project
#[tauri::command]
pub async fn detect_test_framework(workspace_path: String) -> Result<TestFramework, String> {
    tokio::task::spawn_blocking(move || {
        let path = PathBuf::from(&workspace_path);

        if !path.exists() {
            return Err(format!("Workspace path does not exist: {}", workspace_path));
        }

        let framework = detection::detect_framework(&path);
        tracing::info!(
            framework = ?framework,
            workspace_path = %workspace_path,
            "[TestRunner] Detected framework"
        );

        Ok(framework)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Discover tests in a project
#[tauri::command]
pub async fn discover_tests(
    workspace_path: String,
    framework: Option<TestFramework>,
) -> Result<DiscoveryResult, String> {
    let path = PathBuf::from(&workspace_path);

    if !path.exists() {
        return Err(format!("Workspace path does not exist: {}", workspace_path));
    }

    // Detect framework if not provided
    let detected_framework = framework.unwrap_or_else(|| detection::detect_framework(&path));
    tracing::info!(
        framework = ?detected_framework,
        workspace_path = %workspace_path,
        "[TestRunner] Discovering tests"
    );

    // Discover test files
    let items = discovery::discover_tests(&path, &detected_framework)?;
    tracing::info!(
        test_file_count = items.len(),
        "[TestRunner] Found test files"
    );

    // Get workspace name from path
    let workspace_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace".to_string());

    // Build tree structure
    let tree = discovery::build_test_tree(items.clone(), &workspace_name);

    // Count total tests
    let test_count = items.len() as u32;

    Ok(DiscoveryResult {
        framework: detected_framework,
        items: tree,
        test_count,
    })
}

/// Run tests in a project
#[tauri::command]
pub async fn run_tests(
    app: AppHandle,
    workspace_path: String,
    test_ids: Option<Vec<String>>,
    framework: Option<TestFramework>,
    state: State<'_, TestRunnerState>,
) -> Result<TestRunSummary, String> {
    let path = PathBuf::from(&workspace_path);

    if !path.exists() {
        return Err(format!("Workspace path does not exist: {}", workspace_path));
    }

    // Detect framework if not provided
    let detected_framework = framework.unwrap_or_else(|| detection::detect_framework(&path));

    if detected_framework == TestFramework::Unknown {
        return Err("No test framework detected in project".to_string());
    }

    // Mint the canonical run id and register it before the runner emits
    // anything, so a stop request for the id seen on `run_started` always
    // finds this entry.
    let run_id = uuid::Uuid::new_v4().to_string();
    let cancel = state.begin(&run_id);
    let _guard = RunGuard {
        state: state.inner(),
        run_id: &run_id,
    };

    let emit = move |event: TestEvent| {
        let _ = app.emit("test-event", event);
    };

    runner::run_tests(
        run_id.clone(),
        &path,
        detected_framework,
        test_ids,
        cancel,
        &emit,
    )
    .await
}

/// Signal cancellation for a running test run.
///
/// Returns `true` when an active run was signalled; the terminated run then
/// reports itself via a `run_cancelled` event. Returns `false` when the run
/// had already finished — callers should treat that as "nothing to stop",
/// not as a failure.
#[tauri::command]
pub async fn stop_tests(run_id: String, state: State<'_, TestRunnerState>) -> Result<bool, String> {
    Ok(state.request_stop(&run_id))
}

/// Get test patterns for a framework (useful for frontend filtering)
#[tauri::command]
pub fn get_test_patterns(framework: TestFramework) -> Vec<String> {
    detection::get_test_patterns(&framework)
        .iter()
        .map(|s| s.to_string())
        .collect()
}

#[cfg(test)]
#[path = "tests/commands_tests.rs"]
mod tests;
