/**
 * useTestRunner Hook
 *
 * React hook for test runner functionality.
 * Thin wrapper around TestService - provides React bindings for state.
 *
 * All actual logic is in TestService (singleton).
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { TestService } from "@src/services/test";
import {
  failedTestsAtom,
  isDiscoveringAtom,
  isRunningAtom,
  lastRunSummaryAtom,
  testCountsAtom,
  testFrameworkAtom,
  testItemsAtom,
} from "@src/store/workstation/codeEditor/testRunner";
import type {
  TestFramework,
  TestItem,
  TestRunSummary,
} from "@src/types/testing";
import { isTauriReady } from "@src/util/platform/tauri/init";

export interface UseTestRunnerOptions {
  repoPath: string;
  autoDiscover?: boolean;
  isActive?: boolean;
}

export interface UseTestRunnerReturn {
  // State (from atoms)
  testItems: TestItem[];
  framework: TestFramework;
  isRunning: boolean;
  isDiscovering: boolean;
  lastSummary: TestRunSummary | null;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    running: number;
    total: number;
  };
  failedTests: unknown[];

  // Actions (delegate to TestService)
  detectFramework: () => Promise<TestFramework>;
  discoverTests: () => Promise<TestItem[]>;
  runTests: (testIds?: string[]) => Promise<TestRunSummary | null>;
  runTest: (testId: string) => Promise<TestRunSummary | null>;
  runAllTests: () => Promise<TestRunSummary | null>;
  stopTests: () => Promise<void>;
  clearResults: () => void;

  // Standardized actions sub-object for dispatcher integration
  actions: {
    detectFramework: () => Promise<TestFramework>;
    discover: () => Promise<TestItem[]>;
    runAll: () => Promise<TestRunSummary | null>;
    runFile: (filePath: string) => Promise<TestRunSummary | null>;
    runTests: (testIds?: string[]) => Promise<TestRunSummary | null>;
    stop: () => Promise<void>;
    clear: () => void;
  };
}

export function useTestRunner({
  repoPath,
  autoDiscover = true,
  isActive = true,
}: UseTestRunnerOptions): UseTestRunnerReturn {
  // Read state from atoms (TestService updates these)
  const testItems = useAtomValue(testItemsAtom);
  const framework = useAtomValue(testFrameworkAtom);
  const isRunning = useAtomValue(isRunningAtom);
  const isDiscovering = useAtomValue(isDiscoveringAtom);
  const lastSummary = useAtomValue(lastRunSummaryAtom);
  const counts = useAtomValue(testCountsAtom);
  const failedTests = useAtomValue(failedTestsAtom);

  // Track if we've already discovered tests for this repo
  const hasDiscoveredRef = useRef(false);

  // Actions - delegate to TestService
  const detectFramework = useCallback(async (): Promise<TestFramework> => {
    return TestService.detectFramework(repoPath);
  }, [repoPath]);

  const discoverTests = useCallback(async (): Promise<TestItem[]> => {
    return TestService.discoverTests(repoPath);
  }, [repoPath]);

  const runTests = useCallback(
    async (testIds?: string[]): Promise<TestRunSummary | null> => {
      return TestService.runTests(repoPath, testIds);
    },
    [repoPath]
  );

  const runTest = useCallback(
    async (testId: string): Promise<TestRunSummary | null> => {
      return TestService.runTest(repoPath, testId);
    },
    [repoPath]
  );

  const runAllTests = useCallback(async (): Promise<TestRunSummary | null> => {
    return TestService.runAll(repoPath);
  }, [repoPath]);

  const stopTests = useCallback(async (): Promise<void> => {
    return TestService.stop();
  }, []);

  const clearResults = useCallback((): void => {
    TestService.clear();
  }, []);

  // Auto-discover on mount or when becoming active
  useEffect(() => {
    if (
      autoDiscover &&
      repoPath &&
      isTauriReady() &&
      isActive &&
      !hasDiscoveredRef.current
    ) {
      detectFramework().then((fw) => {
        if (fw !== "unknown") {
          discoverTests().then(() => {
            hasDiscoveredRef.current = true;
          });
        } else {
          hasDiscoveredRef.current = true;
        }
      });
    }
  }, [autoDiscover, repoPath, isActive, detectFramework, discoverTests]);

  // Reset discovery flag when repo path changes
  useEffect(() => {
    hasDiscoveredRef.current = false;
  }, [repoPath]);

  // Standardized actions interface for dispatcher integration
  const actions = useMemo(
    () => ({
      detectFramework,
      discover: discoverTests,
      runAll: runAllTests,
      runFile: runTest,
      runTests,
      stop: stopTests,
      clear: clearResults,
    }),
    [
      detectFramework,
      discoverTests,
      runAllTests,
      runTest,
      runTests,
      stopTests,
      clearResults,
    ]
  );

  return {
    // State
    testItems,
    framework,
    isRunning,
    isDiscovering,
    lastSummary,
    counts,
    failedTests,

    // Actions
    detectFramework,
    discoverTests,
    runTests,
    runTest,
    runAllTests,
    stopTests,
    clearResults,

    // Standardized actions sub-object
    actions,
  };
}

export default useTestRunner;
