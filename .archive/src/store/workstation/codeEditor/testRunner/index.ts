/**
 * Test Runner Store
 *
 * Jotai atoms for test runner state management.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type {
  TestCounts,
  TestFramework,
  TestItem,
  TestResult,
  TestRunState,
  TestRunSummary,
} from "@src/types/testing";

// ============================================
// Core State Atoms
// ============================================

/** Discovered test items (tree structure) */
export const testItemsAtom = atom<TestItem[]>([]);

/** Detected test framework */
export const testFrameworkAtom = atom<TestFramework>("unknown");

/** Current test run (if running) */
export const currentRunAtom = atom<TestRunState | null>(null);

/** All test results from current/last run (keyed by testId) */
export const testResultsAtom = atom<Map<string, TestResult>>(new Map());

/** Last test run summary */
export const lastRunSummaryAtom = atom<TestRunSummary | null>(null);

/** Loading state for discovery */
export const isDiscoveringAtom = atom<boolean>(false);

// ============================================
// Derived Atoms
// ============================================

/** Test items with status merged from results */
export const testItemsWithStatusAtom = atom((get) => {
  const items = get(testItemsAtom);
  const results = get(testResultsAtom);

  function mergeStatus(item: TestItem): TestItem {
    const result = results.get(item.id);
    return {
      ...item,
      status: result?.status ?? item.status,
      duration: result?.durationMs ?? item.duration,
      children: item.children.map(mergeStatus),
    };
  }

  return items.map(mergeStatus);
});

/** Failed tests only */
export const failedTestsAtom = atom((get) => {
  const results = get(testResultsAtom);
  return Array.from(results.values()).filter(
    (result) => result.status === "failed" || result.status === "errored"
  );
});

/** Test counts summary */
export const testCountsAtom = atom<TestCounts>((get) => {
  const results = get(testResultsAtom);
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let running = 0;

  for (const result of results.values()) {
    switch (result.status) {
      case "passed":
        passed++;
        break;
      case "failed":
      case "errored":
        failed++;
        break;
      case "skipped":
        skipped++;
        break;
      case "running":
        running++;
        break;
    }
  }

  return { passed, failed, skipped, running, total: results.size };
});

/** Is test run in progress */
export const isRunningAtom = atom((get) => {
  return get(currentRunAtom)?.status === "running";
});

/** Has any test results */
export const hasResultsAtom = atom((get) => {
  return get(testResultsAtom).size > 0;
});

// ============================================
// Settings (persisted)
// ============================================

export interface TestSettings {
  autoRun: boolean; // Run tests on file save
  showPassingTests: boolean; // Show passing tests in tree
  collapsePassedFiles: boolean;
  watchMode: boolean;
}

export const testSettingsAtom = atomWithStorage<TestSettings>("test_settings", {
  autoRun: false,
  showPassingTests: true,
  collapsePassedFiles: false,
  watchMode: false,
});

// ============================================
// Action Atoms
// ============================================

/** Add/update a test result */
export const updateTestResultAtom = atom(
  null,
  (get, set, result: TestResult) => {
    const results = new Map(get(testResultsAtom));
    results.set(result.testId, result);
    set(testResultsAtom, results);
  }
);

/** Clear all results */
export const clearResultsAtom = atom(null, (_get, set) => {
  set(testResultsAtom, new Map());
  set(currentRunAtom, null);
  set(lastRunSummaryAtom, null);
});

/** Set test items (from discovery) */
export const setTestItemsAtom = atom(null, (_get, set, items: TestItem[]) => {
  set(testItemsAtom, items);
});

/** Set framework */
export const setFrameworkAtom = atom(
  null,
  (_get, set, framework: TestFramework) => {
    set(testFrameworkAtom, framework);
  }
);

/** Set current run state */
export const setCurrentRunAtom = atom(
  null,
  (_get, set, run: TestRunState | null) => {
    set(currentRunAtom, run);
  }
);

/** Set last run summary */
export const setLastSummaryAtom = atom(
  null,
  (_get, set, summary: TestRunSummary | null) => {
    set(lastRunSummaryAtom, summary);
  }
);

/** Set discovering state */
export const setDiscoveringAtom = atom(
  null,
  (_get, set, discovering: boolean) => {
    set(isDiscoveringAtom, discovering);
  }
);
