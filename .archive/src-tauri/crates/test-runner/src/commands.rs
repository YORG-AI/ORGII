//! Tauri command handlers for the test runner.

use crate::detection;
use crate::discovery;
use crate::runner;
use crate::types::*;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// State for tracking running test processes
pub struct TestRunnerState {
    /// Map of run_id to cancellation flag
    running: Arc<Mutex<HashMap<String, bool>>>,
}

impl TestRunnerState {
    pub fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for TestRunnerState {
    fn default() -> Self {
        Self::new()
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

    // Mark as running
    let run_id = uuid::Uuid::new_v4().to_string();
    {
        let mut running = state.running.lock().await;
        running.insert(run_id.clone(), false);
    }

    // Run tests
    let result = runner::run_tests(app, &path, detected_framework, test_ids).await;

    // Remove from running
    {
        let mut running = state.running.lock().await;
        running.remove(&run_id);
    }

    result
}

/// Stop a running test
#[tauri::command]
pub async fn stop_tests(run_id: String, state: State<'_, TestRunnerState>) -> Result<(), String> {
    let mut running = state.running.lock().await;

    if let Some(cancelled) = running.get_mut(&run_id) {
        *cancelled = true;
        Ok(())
    } else {
        Err(format!("No running test with id: {}", run_id))
    }
}

/// Get test patterns for a framework (useful for frontend filtering)
#[tauri::command]
pub fn get_test_patterns(framework: TestFramework) -> Vec<String> {
    detection::get_test_patterns(&framework)
        .iter()
        .map(|s| s.to_string())
        .collect()
}
