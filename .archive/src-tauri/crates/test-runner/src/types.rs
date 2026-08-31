/**
 * Test Runner Types
 *
 * Core type definitions for the test runner module.
 * Mirrors frontend TypeScript types for type-safe communication.
 */
use serde::{Deserialize, Serialize};

/// Supported test frameworks
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TestFramework {
    Jest,
    Vitest,
    Pytest,
    Cargo,
    Mocha,
    #[default]
    Unknown,
}

/// Type of test item in the tree
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TestItemType {
    File,
    Suite,
    Test,
}

/// Status of a test
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum TestStatus {
    #[default]
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
    Errored,
}

/// Test item in the tree (file, suite, or individual test)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub item_type: TestItemType,
    #[serde(default)]
    pub children: Vec<TestItem>,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

/// Result of a single test
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub test_id: String,
    pub status: TestStatus,
    pub duration_ms: Option<u64>,
    pub error_message: Option<String>,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub stack_trace: Option<String>,
    pub file_path: Option<String>,
    pub line: Option<u32>,
}

/// Summary of a test run
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSummary {
    pub run_id: String,
    pub framework: TestFramework,
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub duration_ms: u64,
    pub results: Vec<TestResult>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Events emitted during test run (for streaming to frontend)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TestEvent {
    RunStarted { run_id: String, total_tests: u32 },
    TestStarted { test_id: String, name: String },
    TestFinished { result: TestResult },
    RunFinished { summary: TestRunSummary },
    Error { message: String },
}

/// Request to run tests
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTestsRequest {
    pub workspace_path: String,
    pub test_ids: Option<Vec<String>>,
    pub framework: Option<TestFramework>,
}

/// Discovery result
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub framework: TestFramework,
    pub items: Vec<TestItem>,
    pub test_count: u32,
}
