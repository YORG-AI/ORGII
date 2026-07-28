/**
 * Pipeline grouping tests: exploration, reads, terminals, edits, and browser actions.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { processChatItems } from "../pipeline";
import type { OptimizedChatItem } from "../types";
import {
  makeAwaitItem,
  makeBrowserItem,
  makeCliAliasItem,
  makeDeleteFileItem,
  makeEditFileItem,
  makeInspectTerminalsItem,
  makeListDirItem,
  makeReadFileItem,
  makeSearchItem,
  makeShellItem,
} from "./pipeline.testUtils";

beforeEach(() => {
  resetActivityCounter();
});

describe("processChatItems", () => {
  describe("action summary grouping", () => {
    it("groups consecutive exploration tools into actionSummaryGroup", () => {
      const readItem = makeReadFileItem("a.ts");
      const searchItem = makeSearchItem("handleClick");
      const listItem = makeListDirItem("src/");

      const { items } = processChatItems([readItem, searchItem, listItem], {
        groupActionSummaries: true,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("actionSummaryGroup");
      const summaryItem = items[0] as OptimizedChatItem;
      expect(summaryItem.actionSummaryEntries).toBeDefined();
      expect(summaryItem.actionSummaryItems?.length).toBe(3);
      expect(summaryItem.actionSummaryClosedByBoundary).toBe(false);
    });

    it("groups CLI exploration aliases using uiCanonical", () => {
      const readItem = makeCliAliasItem("Read", "read_file", {
        file_path: "a.ts",
      });
      const grepItem = makeCliAliasItem("Grep", "code_search", {
        pattern: "handleClick",
      });
      const listItem = makeCliAliasItem("LS", "list_dir", {
        path: "src/",
      });

      const { items } = processChatItems([readItem, grepItem, listItem], {
        groupActionSummaries: true,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("actionSummaryGroup");
      const summaryItem = items[0] as OptimizedChatItem;
      expect(summaryItem.actionSummaryItems?.length).toBe(3);
    });

    it("keeps action summary group key stable when first tool transitions to result", () => {
      const runningRead = makeSessionEvent({
        id: "tool-call-read-1",
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "a.ts" },
        result: { status: "running", call_id: "call-read-1" },
        callId: "call-read-1",
      });
      const completedRead = makeSessionEvent({
        id: "tool-result-read-1",
        action_type: "tool_result",
        function: "read_file",
        args: { file_path: "a.ts" },
        result: { content: "a", call_id: "call-read-1" },
        callId: "call-read-1",
      });
      const searchItem = makeSearchItem("handleClick");

      const runningGroup = processChatItems([runningRead, searchItem], {
        groupActionSummaries: true,
        preFilterEmptyActivities: false,
      });
      const completedGroup = processChatItems(
        [runningRead, completedRead, searchItem],
        {
          groupActionSummaries: true,
          preFilterEmptyActivities: false,
        }
      );

      expect(runningGroup.items[0].chunk_id).toBe(
        completedGroup.items[0].chunk_id
      );
      expect(completedGroup.items[0].chunk_id).toBe(
        "group:actionsummary:tool:session-test-001:call-read-1"
      );
    });

    it("marks exploration groups closed when a following event does not fit", () => {
      const readItem = makeReadFileItem("a.ts");
      const searchItem = makeSearchItem("handleClick");
      const shellItem = makeShellItem("npm test");

      const { items } = processChatItems([readItem, searchItem, shellItem], {
        groupActionSummaries: true,
        groupTerminalActivities: false,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(2);
      const summaryItem = items[0] as OptimizedChatItem;
      expect(summaryItem.type).toBe("actionSummaryGroup");
      expect(summaryItem.actionSummaryClosedByBoundary).toBe(true);
      expect(items[1].event?.id).toBe(shellItem.id);
    });

    it("keeps trailing exploration groups open until a non-fitting event arrives", () => {
      const readItem = makeReadFileItem("a.ts");
      const searchItem = makeSearchItem("handleClick");

      const { items } = processChatItems([readItem, searchItem], {
        groupActionSummaries: true,
        preFilterEmptyActivities: false,
      });

      const summaryItem = items[0] as OptimizedChatItem;
      expect(summaryItem.actionSummaryClosedByBoundary).toBe(false);
    });

    it("does not group when groupActionSummaries is false", () => {
      const readItem = makeReadFileItem("a.ts");
      const searchItem = makeSearchItem("term");

      const { items } = processChatItems([readItem, searchItem], {
        groupActionSummaries: false,
        groupReadFileActivities: false,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(2);
      expect(items.every((item) => item.type === "activity")).toBe(true);
    });

    it("includes failed reads in the surrounding exploration group", () => {
      const readItem = makeReadFileItem("a.ts");
      const searchItem = makeSearchItem("handleClick");
      const failedReadItem = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "missing.ts" },
        status: "failed",
        result: {
          success: false,
          error_message: "File could not be read",
        },
      });

      const { items } = processChatItems(
        [readItem, searchItem, failedReadItem],
        {
          groupActionSummaries: true,
          preFilterEmptyActivities: false,
        }
      );

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("actionSummaryGroup");
      expect(items[0].actionSummaryItems?.map(({ event }) => event.id)).toEqual(
        [readItem.id, searchItem.id, failedReadItem.id]
      );
      expect(
        items[0].actionSummaryEntries?.find(
          ({ category }) => category === "read"
        )?.events
      ).toEqual([readItem, failedReadItem]);
      expect(items[0].actionSummaryItems?.at(-1)?.event.result).toEqual({
        success: false,
        error_message: "File could not be read",
      });
    });

    it("keeps a single read_file as an activity when below minActionSummaryToGroup", () => {
      const readItem = makeReadFileItem("a.ts");

      const { items } = processChatItems([readItem], {
        groupActionSummaries: true,
        minActionSummaryToGroup: 2,
        preFilterEmptyActivities: false,
      });

      expect(items.length).toBe(1);
      expect(items[0].type).toBe("activity");
      expect(items[0].event?.id).toBe(readItem.id);
    });

    it("breaks group when non-exploration tool appears", () => {
      const readItem = makeReadFileItem("a.ts");
      const shellItem = makeShellItem("npm test");
      const searchItem = makeSearchItem("query");

      const { items } = processChatItems([readItem, shellItem, searchItem], {
        groupActionSummaries: true,
        groupTerminalActivities: false,
        preFilterEmptyActivities: false,
      });

      const types = items.map((item) => item.type);
      expect(types[0]).toBe("activity");
      expect(types[1]).toBe("activity");
      expect(types[2]).toBe("activity");
    });
  });

  describe("read file grouping (when action summaries disabled)", () => {
    it("groups consecutive read_file activities", () => {
      const items = [
        makeReadFileItem("a.ts"),
        makeReadFileItem("b.ts"),
        makeReadFileItem("c.ts"),
      ];

      const { items: result } = processChatItems(items, {
        groupReadFileActivities: true,
        groupActionSummaries: false,
        preFilterEmptyActivities: false,
      });

      expect(result.length).toBe(1);
      expect(result[0].type).toBe("readFileGroup");
      const groupItem = result[0] as OptimizedChatItem;
      expect(groupItem.readFileEvents?.length).toBe(3);
    });

    it("does not group when below minReadFilesToGroup", () => {
      const items = [makeReadFileItem("a.ts")];

      const { items: result } = processChatItems(items, {
        groupReadFileActivities: true,
        groupActionSummaries: false,
        minReadFilesToGroup: 2,
        preFilterEmptyActivities: false,
      });

      expect(result.length).toBe(1);
      expect(result[0].type).toBe("activity");
    });

    it("does not group when groupReadFileActivities is false", () => {
      const items = [makeReadFileItem("a.ts"), makeReadFileItem("b.ts")];

      const { items: result } = processChatItems(items, {
        groupReadFileActivities: false,
        groupActionSummaries: false,
        preFilterEmptyActivities: false,
      });

      expect(result.length).toBe(2);
    });
  });

  describe("terminal grouping", () => {
    it("groups a single terminal command", () => {
      const command = makeShellItem("git status");

      const { items } = processChatItems([command], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("terminal");
      expect(items[0].activityStackGroup?.events).toEqual([command]);
    });

    it("groups commands, shell waits, and terminal inspections together", () => {
      const terminalActivities = [
        makeShellItem("git status"),
        makeAwaitItem("shell", "48291"),
        makeInspectTerminalsItem(),
      ];

      const { items } = processChatItems(terminalActivities, {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("terminal");
      expect(items[0].activityStackGroup?.events).toEqual(terminalActivities);
      expect(items[0].activityStackGroup?.closedByBoundary).toBe(false);
    });

    it("groups consecutive MCP calls into the command stack", () => {
      const mcpCalls = [
        makeSessionEvent({
          action_type: "tool_call",
          function: "mcp_node_repl_js",
          result: { success: true },
        }),
        makeSessionEvent({
          action_type: "tool_call",
          function: "codex_app__read_thread_terminal",
          result: { success: true },
        }),
      ];

      const { items } = processChatItems(mcpCalls, {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("terminal");
      expect(items[0].activityStackGroup?.events).toEqual(mcpCalls);
    });

    it("groups shell commands and MCP calls in their original order", () => {
      const command = makeShellItem("git status");
      const mcpCall = makeSessionEvent({
        action_type: "tool_call",
        function: "codex_app__read_thread_terminal",
        result: { success: true },
      });

      const { items } = processChatItems([command, mcpCall], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].activityStackGroup?.events).toEqual([command, mcpCall]);
    });

    it("keeps subagent-only waits outside terminal stacks", () => {
      const first = makeShellItem("git status");
      const subagentWait = makeAwaitItem(
        "subagent",
        "agent-builtin:explore-abc123"
      );
      const second = makeShellItem("git diff");

      const { items } = processChatItems([first, subagentWait, second], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(3);
      expect(items.map((item) => item.type)).toEqual([
        "activityStackGroup",
        "activity",
        "activityStackGroup",
      ]);
      expect(items[1].event?.id).toBe(subagentWait.id);
    });

    it("does not create a terminal stack without a command anchor", () => {
      const wait = makeAwaitItem("shell", "48291");
      const check = makeInspectTerminalsItem();

      const { items } = processChatItems([wait, check], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(2);
      expect(items.every((item) => item.type === "activity")).toBe(true);
    });

    it("closes a terminal stack when a different event follows", () => {
      const first = makeShellItem("git status");
      const second = makeShellItem("git diff");
      const search = makeSearchItem("ChatPanel");

      const { items } = processChatItems([first, second, search], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(2);
      expect(items[0].activityStackGroup?.category).toBe("terminal");
      expect(items[0].activityStackGroup?.closedByBoundary).toBe(true);
      expect(items[1].event?.id).toBe(search.id);
    });

    it("groups single commands but keeps kill actions standalone", () => {
      const first = makeShellItem("npm test");
      const kill = makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { kill_handle: "shell-1" },
        result: { success: true },
      });
      const second = makeShellItem("npm run lint");

      const { items } = processChatItems([first, kill, second], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(3);
      expect(items.map((item) => item.type)).toEqual([
        "activityStackGroup",
        "activity",
        "activityStackGroup",
      ]);
      expect(items[1].event?.id).toBe(kill.id);
    });
  });

  describe("edit grouping", () => {
    it("groups a single edit", () => {
      const edit = makeEditFileItem("src/app.ts");

      const { items } = processChatItems([edit], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.events).toEqual([edit]);
      expect(items[0].activityStackGroup?.closedByBoundary).toBe(false);
    });

    it("groups a single deletion as an edit activity", () => {
      const deletion = makeDeleteFileItem("src/obsolete.ts");

      const { items } = processChatItems([deletion], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.events).toEqual([deletion]);
    });

    it("keeps deletions in an edit and read sequence", () => {
      const activities = [
        makeEditFileItem("src/app.ts"),
        makeReadFileItem("src/app.ts"),
        makeDeleteFileItem("src/obsolete.ts"),
      ];

      const { items } = processChatItems(activities, {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].activityStackGroup?.events).toEqual(activities);
    });

    it("includes reads after an edit in the same group", () => {
      const activities = [
        makeEditFileItem("src/app.ts"),
        makeReadFileItem("src/app.ts"),
        makeEditFileItem("src/styles.css"),
      ];

      const { items } = processChatItems(activities, {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.events).toEqual(activities);
    });

    it("keeps reads before the first edit in Explore", () => {
      const read = makeReadFileItem("src/app.ts");
      const search = makeSearchItem("app");
      const edit = makeEditFileItem("src/app.ts");

      const { items } = processChatItems([read, search, edit], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(2);
      expect(items[0].type).toBe("actionSummaryGroup");
      expect(items[1].activityStackGroup?.category).toBe("edit");
      expect(items[1].activityStackGroup?.events).toEqual([edit]);
    });

    it("closes the edit group when another activity follows", () => {
      const edit = makeEditFileItem("src/app.ts");
      const shell = makeShellItem("npm test");

      const { items } = processChatItems([edit, shell], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(2);
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.closedByBoundary).toBe(true);
      expect(items[1].activityStackGroup?.category).toBe("terminal");
    });

    it("groups failed edits", () => {
      const failedEdit = makeSessionEvent({
        action_type: "tool_call",
        function: "edit_file",
        uiCanonical: "edit_file",
        args: { file_path: "src/app.ts" },
        result: { success: false, error: "edit failed" },
      });

      const { items } = processChatItems([failedEdit], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.events).toEqual([failedEdit]);
    });

    it("groups failed deletions", () => {
      const failedDeletion = makeSessionEvent({
        action_type: "tool_call",
        function: "delete_file",
        uiCanonical: "delete_file",
        args: { file_path: "src/obsolete.ts" },
        result: { success: false, error: "delete failed" },
      });

      const { items } = processChatItems([failedDeletion], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("activityStackGroup");
      expect(items[0].activityStackGroup?.category).toBe("edit");
      expect(items[0].activityStackGroup?.events).toEqual([failedDeletion]);
    });

    it("keeps successful and failed modifications in one group", () => {
      const successfulEdit = makeEditFileItem("src/app.ts");
      const failedDeletion = makeSessionEvent({
        action_type: "tool_call",
        function: "delete_file",
        uiCanonical: "delete_file",
        args: { file_path: "src/obsolete.ts" },
        result: { success: false, error: "delete failed" },
      });

      const { items } = processChatItems([successfulEdit, failedDeletion], {
        preFilterEmptyActivities: false,
      });

      expect(items).toHaveLength(1);
      expect(items[0].activityStackGroup?.events).toEqual([
        successfulEdit,
        failedDeletion,
      ]);
    });
  });

  describe("browser stacking", () => {
    it("stacks consecutive browser actions", () => {
      const items = [makeBrowserItem("navigate"), makeBrowserItem("click")];

      const { items: result } = processChatItems(items, {
        stackBrowserActions: true,
        groupActionSummaries: false,
        preFilterEmptyActivities: false,
      });

      expect(result.length).toBe(1);
      expect(result[0].type).toBe("activityStackGroup");
      const stackItem = result[0] as OptimizedChatItem;
      expect(stackItem.activityStackGroup?.category).toBe("browser");
      expect(stackItem.activityStackGroup?.events.length).toBe(2);
    });

    it("does not stack when stackBrowserActions is false", () => {
      const items = [makeBrowserItem("navigate"), makeBrowserItem("click")];

      const { items: result } = processChatItems(items, {
        stackBrowserActions: false,
        groupActionSummaries: false,
        preFilterEmptyActivities: false,
      });

      expect(result.length).toBe(2);
      expect(result.every((item) => item.type === "activity")).toBe(true);
    });
  });
});
