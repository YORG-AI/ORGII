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
          store.set(setCurrentRunAtom, {
            runId: data.runId,
            status: "running",
            progress: 0,
          });
          break;

        case "test_started":
          store.set(updateTestResultAtom, {
            testId: data.testId,
            status: "running",
          });
          break;

        case "test_finished":
          store.set(updateTestResultAtom, data.result);
          break;

        case "run_finished":
          store.set(setCurrentRunAtom, {
            runId: data.summary.runId,
            status: "completed",
            progress: 100,
          });
          store.set(lastRunSummaryAtom, data.summary);
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
   * Stop running tests
   */
  async stop(): Promise<void> {
    // TODO: Implement when backend supports cancellation
    getStore().set(setCurrentRunAtom, null);
  },

  /**
   * Clear test results
   */
  clear(): void {
    getStore().set(clearResultsAtom);
  },
};
