/**
 * Test Runner Types
 *
 * Types for the test runner system.
 * Mirrors Rust backend types for type-safe Tauri communication.
 */

// ============================================
// Core Enums
// ============================================

export type TestFramework =
  | "jest"
  | "vitest"
  | "pytest"
  | "cargo"
  | "mocha"
  | "unknown";

export type TestItemType = "file" | "suite" | "test";

export type TestStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "errored";

// ============================================
// Core Types
// ============================================

/** Test item in the tree (file, suite, or individual test) */
export interface TestItem {
  id: string;
  name: string;
  path: string;
  itemType: TestItemType;
  children: TestItem[];
  line?: number;
  column?: number;
  // Runtime state (merged from results)
  status?: TestStatus;
  duration?: number;
}

/** Result of a single test */
export interface TestResult {
  testId: string;
  status: TestStatus;
  durationMs?: number;
  errorMessage?: string;
  expected?: string;
  actual?: string;
  stackTrace?: string;
  filePath?: string;
  line?: number;
}

/** Summary of a test run */
export interface TestRunSummary {
  runId: string;
  framework: TestFramework;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TestResult[];
  startedAt: string;
  finishedAt?: string;
}

/** Discovery result from backend */
export interface DiscoveryResult {
  framework: TestFramework;
  items: TestItem[];
  testCount: number;
}

// ============================================
// Event Types (from Tauri)
// ============================================

export type TestEvent =
  | { type: "run_started"; runId: string; totalTests: number }
  | { type: "test_started"; testId: string; name: string }
  | { type: "test_finished"; result: TestResult }
  | { type: "run_finished"; summary: TestRunSummary }
  | { type: "error"; message: string };

// ============================================
// UI State Types
// ============================================

export interface TestRunState {
  runId: string;
  status: "running" | "completed" | "cancelled";
  progress: number; // 0-100
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
  running: number;
  total: number;
}

// ============================================
// Helper Functions
// ============================================

export function getFrameworkLabel(framework: TestFramework): string {
  const labels: Record<TestFramework, string> = {
    jest: "Jest",
    vitest: "Vitest",
    pytest: "Pytest",
    cargo: "Cargo Test",
    mocha: "Mocha",
    unknown: "Unknown",
  };
  return labels[framework];
}

export function getStatusIcon(status: TestStatus): string {
  const icons: Record<TestStatus, string> = {
    pending: "○",
    running: "◐",
    passed: "✓",
    failed: "✕",
    skipped: "○",
    errored: "⚠",
  };
  return icons[status];
}

export function getTestStatusColor(status: TestStatus): string {
  const colors: Record<TestStatus, string> = {
    pending: "text-text-3",
    running: "text-primary-6",
    passed: "text-success-6",
    failed: "text-danger-6",
    skipped: "text-text-3",
    errored: "text-warning-6",
  };
  return colors[status];
}

/** Count tests recursively in a tree */
export function countTests(items: TestItem[]): number {
  let count = 0;
  for (const item of items) {
    if (item.itemType === "test" || item.itemType === "file") {
      count += 1;
    }
    if (item.children.length > 0) {
      count += countTests(item.children);
    }
  }
  return count;
}

/** Flatten test tree to get all test IDs */
export function flattenTestIds(items: TestItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.itemType === "test" || item.itemType === "file") {
      ids.push(item.id);
    }
    if (item.children.length > 0) {
      ids.push(...flattenTestIds(item.children));
    }
  }
  return ids;
}
