/**
 * TestService - Singleton Test Runner Service
 *
 * Provides test runner capabilities shared by both AI and UI.
 * This is the single source of truth for test operations.
 *
 * Usage:
 *   import { TestService } from "@src/services/test";
 *   await TestService.runAll(repoPath);
 */
import { createLogger } from "@src/hooks/logger";
import {
  clearResultsAtom,
  currentRunAtom,
  lastRunSummaryAtom,
  setCurrentRunAtom,
  setDiscoveringAtom,
  testFrameworkAtom,
  testItemsAtom,
  updateTestResultAtom,
} from "@src/store/workstation/codeEditor/testRunner";
import type {
  DiscoveryResult,
  TestEvent,
  TestFramework,
  TestItem,
  TestRunSummary,
} from "@src/types/testing";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  invokeTauri,
  isTauriReady,
  listenTauri,
} from "@src/util/platform/tauri/init";

import { nextRunState, stopTargetRunId } from "./testRunLifecycle";

const log = createLogger("TestService");

// ============================================
// Jotai Store Access (uses app's instrumented store)
// ============================================

const getStore = () => getInstrumentedStore();

// ============================================
// Event Listener Management
// ============================================

let eventListenerInitialized = false;
let unlistenFn: (() => void) | null = null;

/**
 * Initialize the test event listener (called once at app startup)
 */
async function initializeEventListener(): Promise<void> {
  if (eventListenerInitialized || !isTauriReady()) {
    return;
  }

  try {
    unlistenFn = await listenTauri<TestEvent>("test-event", (event) => {
      const data = event.payload;
      const store = getStore();

      switch (data.type) {
        case "run_started":
        case "run_finished":
        case "run_cancelled": {
          const current = store.get(currentRunAtom);
          const next = nextRunState(current, data);
          if (next !== current) {
            store.set(setCurrentRunAtom, next);
          }
          if (data.type === "run_finished") {
            store.set(lastRunSummaryAtom, data.summary);
          }
          break;
        }

        case "test_started":
          store.set(updateTestResultAtom, {
            testId: data.testId,
            status: "running",
          });
          break;

        case "test_finished":
          store.set(updateTestResultAtom, data.result);
          break;

        case "error":
          log.error("[TestService] Test error:", data.message);
          break;
      }
    });

    eventListenerInitialized = true;
  } catch (error) {
    log.error("[TestService] Failed to initialize event listener:", error);
  }
}

/**
 * Cleanup event listener (called at app shutdown)
 */
function cleanupEventListener(): void {
  if (unlistenFn) {
    unlistenFn();
    unlistenFn = null;
  }
  eventListenerInitialized = false;
}

// ============================================
// TestService - Singleton API
// ============================================

export const TestService = {
  /**
   * Initialize the service (call once at app startup)
   */
  async initialize(): Promise<void> {
    await initializeEventListener();
  },

  /**
   * Cleanup the service (call at app shutdown)
   */
  cleanup(): void {
    cleanupEventListener();
  },

  /**
   * Detect the test framework for a project
   */
  async detectFramework(repoPath: string): Promise<TestFramework> {
    if (!isTauriReady() || !repoPath) {
      return "unknown";
    }

    try {
      const detected = await invokeTauri<TestFramework>(
        "detect_test_framework",
        { workspacePath: repoPath }
      );
      getStore().set(testFrameworkAtom, detected);
      return detected;
    } catch (error) {
      log.error("[TestService] Failed to detect framework:", error);
      return "unknown";
    }
  },

  /**
   * Discover tests in a project
   */
  async discoverTests(repoPath: string): Promise<TestItem[]> {
    if (!isTauriReady() || !repoPath) {
      return [];
    }

    const store = getStore();
    store.set(setDiscoveringAtom, true);
    const framework = store.get(testFrameworkAtom);

    try {
      const result = await invokeTauri<DiscoveryResult>("discover_tests", {
        workspacePath: repoPath,
        framework: framework !== "unknown" ? framework : null,
      });
      store.set(testItemsAtom, result.items);
      if (result.framework !== "unknown") {
        store.set(testFrameworkAtom, result.framework);
      }

      return result.items;
    } catch (error) {
      log.error("[TestService] Failed to discover tests:", error);
      return [];
    } finally {
      store.set(setDiscoveringAtom, false);
    }
  },

  /**
   * Run all tests
   */
  async runAll(repoPath: string): Promise<TestRunSummary | null> {
    return this.runTests(repoPath);
  },

  /**
   * Run specific tests by ID
   */
  async runTests(
    repoPath: string,
    testIds?: string[]
  ): Promise<TestRunSummary | null> {
    if (!isTauriReady() || !repoPath) {
      return null;
    }

    const store = getStore();

    // Clear previous results
    store.set(clearResultsAtom);

    const framework = store.get(testFrameworkAtom);

    try {
      const summary = await invokeTauri<TestRunSummary>("run_tests", {
        workspacePath: repoPath,
        testIds: testIds ?? null,
        framework: framework !== "unknown" ? framework : null,
      });

      store.set(lastRunSummaryAtom, summary);
      return summary;
    } catch (error) {
      log.error("[TestService] Failed to run tests:", error);
      return null;
    }
  },

  /**
   * Run a single test
   */
  async runTest(
    repoPath: string,
    testId: string
  ): Promise<TestRunSummary | null> {
    return this.runTests(repoPath, [testId]);
  },

  /**
   * Stop the currently running test run.
   *
   * Signals the backend, which terminates the whole test process tree; the
   * run then reports itself as cancelled via a `run_cancelled` event (this
   * method does not mutate run state locally — the backend confirmation is
   * the source of truth).
   *
   * Returns true when an active run was signalled, false when there was
   * nothing to stop (or the run had already finished).
   */
  async stop(): Promise<boolean> {
    if (!isTauriReady()) {
      return false;
    }

    const runId = stopTargetRunId(getStore().get(currentRunAtom));
    if (!runId) {
      return false;
    }

    try {
      return await invokeTauri<boolean>("stop_tests", { runId });
    } catch (error) {
      log.error("[TestService] Failed to stop tests:", error);
      return false;
    }
  },

  /**
   * Clear test results
   */
  clear(): void {
    getStore().set(clearResultsAtom);
  },
};
