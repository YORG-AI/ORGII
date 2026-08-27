/**
 * Test Actions (Zod-based)
 *
 * Actions for running and managing tests.
 */
import { z } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { PanelService } from "@src/services/panel";
import { TestService } from "@src/services/test";

// ============================================
// Test Actions Factory
// ============================================

/**
 * Create test actions with repoPath closure
 */
export function createTestZodActions(repoPath: string) {
  const testRunAll = defineZodAction(
    {
      id: ACTION_ID.TEST_RUN_ALL,
      category: "test",
      layer: "gui",
      description: "Run all tests in the project",
      params: z.object({}),
      examples: ["run all tests", "test everything", "run tests"],
    },
    async () => {
      PanelService.showPrimarySidebar("testing");
      const summary = await TestService.runAll(repoPath);
      if (!summary) {
        return { success: false, message: "Failed to run tests" };
      }
      return {
        success: true,
        message: `Tests: ${summary.passed} passed, ${summary.failed} failed`,
        data: summary,
      };
    }
  );

  const testDiscover = defineZodAction(
    {
      id: ACTION_ID.TEST_DISCOVER,
      category: "test",
      layer: "action",
      description: "Discover tests in the project",
      params: z.object({}),
      examples: ["discover tests", "find tests", "refresh test list"],
    },
    async () => {
      const tests = await TestService.discoverTests(repoPath);
      return {
        success: true,
        message: `Discovered ${tests.length} tests`,
        data: tests,
      };
    }
  );

  const testStop = defineZodAction(
    {
      id: ACTION_ID.TEST_STOP,
      category: "test",
      layer: "action",
      description: "Stop running tests",
      params: z.object({}),
      examples: ["stop tests", "cancel tests"],
    },
    async () => {
      await TestService.stop();
      return { success: true, message: "Tests stopped" };
    }
  );

  const testRun = defineZodAction(
    {
      id: ACTION_ID.TEST_RUN,
      category: "test",
      layer: "gui",
      description: "Run a specific test by ID",
      params: z.object({
        testId: z
          .string()
          .min(1, "Test ID cannot be empty")
          .describe("Test ID to run"),
      }),
      examples: ["run test auth.login", "run specific test"],
    },
    async ({ testId }) => {
      PanelService.showPrimarySidebar("testing");
      const summary = await TestService.runTest(repoPath, testId);
      if (!summary) {
        return { success: false, message: `Failed to run test: ${testId}` };
      }
      const status = summary.passed > 0 ? "passed" : "failed";
      return {
        success: summary.passed > 0,
        message: `Test ${testId}: ${status}`,
        data: summary,
      };
    }
  );

  return [testRunAll, testDiscover, testStop, testRun];
}

// Default export for static registration (when repoPath not needed)
export const testZodActions = createTestZodActions("");
