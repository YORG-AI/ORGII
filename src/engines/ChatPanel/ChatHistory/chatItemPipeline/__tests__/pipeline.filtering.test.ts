/**
 * Pipeline filtering, statistics, consolidation, and mixed-scenario tests.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { processChatItems } from "../pipeline";
import type { OptimizedChatItem } from "../types";
import {
  makeBrowserItem,
  makeListDirItem,
  makeReadFileItem,
  makeSearchItem,
  makeShellItem,
} from "./pipeline.testUtils";

beforeEach(() => {
  resetActivityCounter();
});

describe("processChatItems", () => {
  describe("submit output", () => {
    it("passes submit_output through as a normal activity", () => {
      const submitEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "submit_output",
        args: {},
        result: { success: true, output: { summary: "Task complete" } },
      });

      const { items } = processChatItems([submitEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("activity");
      expect(items[0].event?.functionName).toBe("submit_output");
    });
  });

  describe("todo filtering", () => {
    it("skips manage_todo and following assistant_message when filterManageTodo is true", () => {
      const todoEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { output: { success: { todos: [] } } },
      });
      const assistantEvent = makeSessionEvent({
        action_type: "assistant",
        function: "assistant_message",
        result: { observation: "Plan created" },
      });
      const shellEvent = makeShellItem("echo after");

      const { items } = processChatItems(
        [todoEvent, assistantEvent, shellEvent],
        {
          filterManageTodo: true,
          preFilterEmptyActivities: false,
          groupActionSummaries: false,
          groupTerminalActivities: false,
        }
      );

      expect(items.length).toBe(1);
      expect(items[0].chunk_id).toBe(shellEvent.id);
    });

    it("keeps manage_todo when filterManageTodo is false", () => {
      const todoEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { output: { success: { todos: [] } } },
      });

      const { items } = processChatItems([todoEvent], {
        filterManageTodo: false,
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
      });

      expect(items.length).toBe(1);
    });

    it("keeps only the latest consecutive todo snapshot", () => {
      const pendingSnapshot = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { success: true, content: "Run relevant verification" },
      });
      const activeSnapshot = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { content: "Verifying Anchor changes" },
      });

      const { items, stats } = processChatItems(
        [pendingSnapshot, activeSnapshot],
        {
          filterManageTodo: false,
          preFilterEmptyActivities: false,
          groupActionSummaries: false,
        }
      );

      expect(items).toHaveLength(1);
      expect(items[0].event?.id).toBe(activeSnapshot.id);
      expect(stats.totalActivities).toBe(2);
      expect(stats.successCount).toBe(0);
      expect(stats.pendingCount).toBe(1);
    });

    it("preserves todo snapshots separated by a real activity", () => {
      const firstSnapshot = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { content: "First snapshot" },
      });
      const shellEvent = makeShellItem("npm test");
      const secondSnapshot = makeSessionEvent({
        action_type: "tool_call",
        function: "manage_todo",
        result: { content: "Second snapshot" },
      });

      const { items } = processChatItems(
        [firstSnapshot, shellEvent, secondSnapshot],
        {
          filterManageTodo: false,
          preFilterEmptyActivities: false,
          groupActionSummaries: false,
        }
      );

      expect(items).toHaveLength(3);
      expect(items[0].event?.id).toBe(firstSnapshot.id);
      expect(items[1].activityStackGroup?.events).toEqual([shellEvent]);
      expect(items[2].event?.id).toBe(secondSnapshot.id);
    });
  });

  describe("pre-filter empty activities", () => {
    it("filters activity with unknown action_type and no observation", () => {
      const emptyEvent = makeSessionEvent({
        action_type: "unknown_type",
        function: "unknown_function",
        args: {},
        result: {},
      });

      const { items } = processChatItems([emptyEvent], {
        preFilterEmptyActivities: true,
        groupActionSummaries: false,
      });

      expect(items.length).toBe(0);
    });

    it("keeps activity when preFilterEmptyActivities is false", () => {
      const emptyEvent = makeSessionEvent({
        action_type: "unknown_type",
        function: "unknown_function",
        args: {},
        result: {},
      });

      const { items } = processChatItems([emptyEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
      });

      expect(items.length).toBe(1);
    });

    it("keeps running shell commands before result arrives", () => {
      const runningShellEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "npm run dev" },
        result: undefined,
        displayStatus: "running",
      });

      const { items } = processChatItems([runningShellEvent], {
        preFilterEmptyActivities: true,
        groupActionSummaries: false,
        groupTerminalActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].event?.functionName).toBe("run_shell");
    });

    it("preserves every repeated CLI error message", () => {
      const first = makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "codex exec" },
        result: { success: false, error: "CLI version is too old" },
      });
      const second = makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "codex exec" },
        result: { success: false, error: "CLI version is too old" },
      });

      const { items, stats } = processChatItems([first, second], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupTerminalActivities: false,
      });

      expect(items).toHaveLength(2);
      expect(items.map((item) => item.event?.result?.error)).toEqual([
        "CLI version is too old",
        "CLI version is too old",
      ]);
      expect(stats.failedCount).toBe(2);
    });
  });

  describe("stats tracking", () => {
    it("counts success, failed, and pending activities correctly", () => {
      const successEvent = makeSessionEvent({
        action_type: "task_completed",
        function: "task_completed",
        result: { success: true },
      });
      const failedEvent = makeSessionEvent({
        action_type: "task_failed",
        function: "task_failed",
        result: { success: false },
      });
      const pendingEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "test" },
        result: { output: { success: { stdout: "ok" } } },
      });

      const { stats } = processChatItems(
        [successEvent, failedEvent, pendingEvent],
        {
          preFilterEmptyActivities: false,
          groupActionSummaries: false,
          groupTerminalActivities: false,
        }
      );

      expect(stats.totalActivities).toBe(3);
      expect(stats.successCount).toBe(1);
      expect(stats.failedCount).toBe(1);
      expect(stats.pendingCount).toBe(1);
    });

    it("counts buffered events in totalActivities (action-summary group)", () => {
      // Three exploration tool_calls collapse into ONE actionSummaryGroup
      // item. totalActivities tracks raw activity count, so it must still
      // be 3 even though items.length is 1.
      const events = [
        makeReadFileItem("a.ts"),
        makeSearchItem("foo"),
        makeListDirItem("src/"),
      ];

      const { items, stats } = processChatItems(events, {
        groupActionSummaries: true,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("actionSummaryGroup");
      expect(stats.totalActivities).toBe(3);
    });

    it("counts buffered events in totalActivities (browser stack)", () => {
      const events = [
        makeBrowserItem("navigate"),
        makeBrowserItem("click"),
        makeBrowserItem("type"),
      ];

      const { items, stats } = processChatItems(events, {
        stackBrowserActions: true,
        groupActionSummaries: false,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(stats.totalActivities).toBe(3);
    });

    it("keeps the loading placeholder standalone without counting it", () => {
      const loadingEvent = makeSessionEvent({
        id: "loading",
        action_type: "tool_call",
        function: "read_file",
        result: {},
      });

      const { items, stats } = processChatItems([loadingEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: true,
      });

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: "activity",
        event: { id: "loading" },
      });
      expect(stats.totalActivities).toBe(0);
    });
  });

  describe("partial observation consolidation", () => {
    it("consolidates consecutive partial observations", () => {
      const part1 = makeSessionEvent({
        action_type: "assistant",
        function: "assistant_message",
        args: {
          thread_id: "thread-1",
          observation_part: "part 1/3",
        },
        result: { observation: "first chunk" },
      });
      const part2 = makeSessionEvent({
        action_type: "assistant",
        function: "assistant_message",
        args: {
          thread_id: "thread-1",
          observation_part: "part 2/3",
        },
        result: { observation: "second chunk" },
      });

      const { items } = processChatItems([part1, part2], {
        consolidatePartialObservations: true,
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(items.length).toBe(1);
      const consolidated = items[0] as OptimizedChatItem;
      expect(consolidated.consolidatedParts).toBe(2);
    });
  });

  describe("mixed scenario", () => {
    it("handles realistic mixed chat history correctly", () => {
      const readItems = [
        makeReadFileItem("src/app.ts"),
        makeReadFileItem("src/utils.ts"),
        makeReadFileItem("src/config.ts"),
      ];
      const shellItem = makeShellItem("npm test", 0);
      const browserItems = [
        makeBrowserItem("navigate"),
        makeBrowserItem("click"),
      ];

      const allItems = [...readItems, shellItem, ...browserItems];
      const { items, stats } = processChatItems(allItems, {
        groupActionSummaries: true,
        stackBrowserActions: true,
        preFilterEmptyActivities: false,
      });

      expect(stats.totalActivities).toBe(6);
      const types = items.map((item) => item.type);
      expect(types).toContain("actionSummaryGroup");
      expect(types).toContain("activityStackGroup");
    });
  });
});
