/**
 * Pipeline Tests — processChatItems
 *
 * End-to-end tests for the main chat item pipeline:
 * dedup, grouping, filtering, stats.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { processChatItems } from "../pipeline";
import type { OptimizedChatItem } from "../types";

beforeEach(() => {
  resetActivityCounter();
});

// ============================================
// Helpers
// ============================================

function makeReadFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "read_file",
    args: { file_path: filePath },
    result: {
      output: {
        success: { content: `content of ${filePath}`, path: filePath },
      },
    },
  });
}

function makeEditFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "edit_file",
    uiCanonical: "edit_file",
    args: { file_path: filePath, old_string: "before", new_string: "after" },
    result: { success: true, file_path: filePath },
  });
}

function makeDeleteFileItem(filePath: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "delete_file",
    uiCanonical: "delete_file",
    args: { file_path: filePath },
    result: { success: true, file_path: filePath },
  });
}

function makeBrowserItem(action = "navigate") {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "browser",
    args: { action, url: "https://example.com" },
    result: { output: { success: { screenshot: "base64..." } } },
  });
}

function makeShellItem(command: string, exitCode = 0) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "run_shell",
    args: { command },
    result: {
      output: {
        success: { command, stdout: `output of ${command}`, exitCode },
      },
    },
  });
}

function makeAwaitItem(jobKind: "shell" | "subagent", handle: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "await_output",
    uiCanonical: "await_output",
    args: { command: "wait_for", handles: [handle] },
    result: {
      output: `awaitMeta::${JSON.stringify({
        count: 1,
        items: [{ handle, jobKind, status: "succeeded" }],
      })}`,
    },
  });
}

function makeInspectTerminalsItem() {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "inspect_terminals",
    args: { action: "read_output", session_id: "terminal-1" },
    result: { success: true },
  });
}

function makeSearchItem(query: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "code_search",
    args: { query },
    result: {
      matches: [{ file: "test.ts", line: 1, content: query }],
      total: 1,
    },
  });
}

function makeListDirItem(directory: string) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: "list_directory",
    args: { directory },
    result: {
      output: {
        success: {
          directoryTreeRoot: {
            absPath: directory,
            childrenDirs: [],
            childrenFiles: [],
          },
        },
      },
    },
  });
}

function makeCliAliasItem(
  functionName: string,
  uiCanonical: string,
  args: Record<string, unknown>
) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: functionName,
    uiCanonical,
    args,
    result: { success: true, content: "ok" },
  });
}

// ============================================
// Tests
// ============================================

describe("processChatItems", () => {
  describe("empty input", () => {
    it("returns empty items and zero stats", () => {
      const { items, stats } = processChatItems([]);
      expect(items).toEqual([]);
      expect(stats.totalActivities).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.failedCount).toBe(0);
      expect(stats.pendingCount).toBe(0);
    });
  });

  describe("basic pass-through", () => {
    it("preserves a single activity item", () => {
      const item = makeShellItem("echo hello");
      const { items, stats } = processChatItems([item], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
      });
      expect(items.length).toBe(1);
      expect(stats.totalActivities).toBe(1);
    });

    it("preserves ordering of multiple items", () => {
      const first = makeShellItem("echo 1");
      const second = makeShellItem("echo 2");
      const { items } = processChatItems([first, second], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupTerminalActivities: false,
      });
      expect(items.length).toBe(2);
      expect(items[0].chunk_id).toBe(first.id);
      expect(items[1].chunk_id).toBe(second.id);
    });
  });

  describe("assistant messages", () => {
    it("filters empty assistant deltas before they create chat rows", () => {
      const emptyDelta = makeSessionEvent({
        id: "assistant-empty-delta",
        action_type: "assistant",
        function: "assistant_message",
        source: "assistant",
        displayVariant: "message",
        displayText: "",
        result: {},
        isDelta: true,
      });

      const { items, stats } = processChatItems([emptyDelta]);

      expect(items).toEqual([]);
      expect(stats.totalActivities).toBe(0);
    });

    it("keeps assistant deltas once they contain visible text", () => {
      const textDelta = makeSessionEvent({
        id: "assistant-text-delta",
        action_type: "assistant",
        function: "assistant_message",
        source: "assistant",
        displayVariant: "message",
        displayText: "Working on it",
        result: {},
        isDelta: true,
      });

      const { items, stats } = processChatItems([textDelta]);

      expect(items).toHaveLength(1);
      expect(items[0].event?.id).toBe("assistant-text-delta");
      expect(stats.totalActivities).toBe(1);
    });
  });

  describe("plan approvals", () => {
    it("does not insert rehydrated pending plan snapshots into the current turn", () => {
      const userMessage = makeSessionEvent({
        id: "user-round-2",
        action_type: "raw_event",
        function: "raw_event",
        source: "user",
        result: { type: "user", message: "Who are you" },
        displayText: "Who are you",
      });
      const rehydratedPlan = makeSessionEvent({
        id: "call_1",
        callId: "call_1",
        action_type: "plan_approval",
        function: "plan_approval",
        args: {
          title: "Sample Display Plan",
          content: "body",
          planId: "plan-1",
          planRevisionId: "call_1",
          originToolCallId: "call_1",
          planEventSource: "rehydrate",
        },
        result: {
          status: "pending",
          planId: "plan-1",
          planRevisionId: "call_1",
        },
      });
      const assistantMessage = makeSessionEvent({
        id: "assistant-round-2",
        action_type: "assistant",
        function: "assistant_message",
        source: "assistant",
        displayText: "I am your AI assistant.",
      });

      const { items } = processChatItems([
        userMessage,
        rehydratedPlan,
        assistantMessage,
      ]);

      expect(items.map((item) => item.event?.id)).toEqual([
        "user-round-2",
        "assistant-round-2",
      ]);
    });

    it("keeps submitted create_plan revisions visible even when new_plan is false", () => {
      const submittedPlan = makeSessionEvent({
        id: "tool-call-call_2",
        callId: "call_2",
        action_type: "tool_call",
        function: "create_plan",
        uiCanonical: "create_plan",
        args: {
          title: "Updated plan",
          content: "# Updated plan",
        },
        result: {
          content:
            'PLAN_SUBMITTED_END_TURN:{"path":"/tmp/plan.md","slug":"updated-plan","hash":"pending","bytes_written":14,"new_plan":false,"submitted_for_review":true}',
          observation:
            'PLAN_SUBMITTED_END_TURN:{"path":"/tmp/plan.md","slug":"updated-plan","hash":"pending","bytes_written":14,"new_plan":false,"submitted_for_review":true}',
        },
        displayStatus: "completed",
        displayText: "Calling create_plan...",
      });

      const { items } = processChatItems([submittedPlan]);

      expect(items).toHaveLength(1);
      expect(items[0].event?.id).toBe("tool-call-call_2");
      expect(items[0].event?.functionName).toBe("create_plan");
    });
  });

  describe("dedup", () => {
    it("skips running tool_call when completed version exists", () => {
      const runningEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "test.ts" },
        result: { status: "running" },
      });
      const completedEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "test.ts" },
        result: {
          output: { success: { content: "done", path: "test.ts" } },
        },
      });
      const { items } = processChatItems([runningEvent, completedEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });
      expect(items.length).toBe(1);
      expect(items[0].chunk_id).toBe(completedEvent.id);
    });

    it("uses call id as stable chunk id for visible tool transitions", () => {
      const runningEvent = makeSessionEvent({
        id: "tool-call-read-1",
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "test.ts" },
        result: { status: "running", call_id: "call-read-1" },
        callId: "call-read-1",
      });
      const completedEvent = makeSessionEvent({
        id: "tool-result-read-1",
        action_type: "tool_result",
        function: "read_file",
        args: { file_path: "test.ts" },
        result: {
          call_id: "call-read-1",
          output: { success: { content: "done", path: "test.ts" } },
        },
        callId: "call-read-1",
      });

      const runningOnly = processChatItems([runningEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });
      const completedOnly = processChatItems([runningEvent, completedEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(runningOnly.items[0].chunk_id).toBe(
        "tool:session-test-001:call-read-1"
      );
      expect(completedOnly.items[0].chunk_id).toBe(
        "tool:session-test-001:call-read-1"
      );
      expect(completedOnly.items[0].event?.id).toBe(completedEvent.id);
    });

    it("scopes stable tool chunk ids by session", () => {
      const firstSessionEvent = makeSessionEvent({
        id: "tool-call-read-session-a",
        sessionId: "session-a",
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "a.ts" },
        result: { status: "running", call_id: "shared-call" },
        callId: "shared-call",
      });
      const secondSessionEvent = makeSessionEvent({
        id: "tool-call-read-session-b",
        sessionId: "session-b",
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "b.ts" },
        result: { status: "running", call_id: "shared-call" },
        callId: "shared-call",
      });

      const firstSessionItems = processChatItems([firstSessionEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });
      const secondSessionItems = processChatItems([secondSessionEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(firstSessionItems.items[0].chunk_id).toBe(
        "tool:session-a:shared-call"
      );
      expect(secondSessionItems.items[0].chunk_id).toBe(
        "tool:session-b:shared-call"
      );
    });

    it("merges args from running event into completed event with empty args", () => {
      const runningEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        args: { file_path: "src/main.ts" },
        result: { status: "running", call_id: "call-123" },
        call_id: "call-123",
      });
      const completedEvent = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        args: {},
        result: {
          call_id: "call-123",
          output: { success: { content: "content", path: "src/main.ts" } },
        },
        call_id: "call-123",
      });

      const { items } = processChatItems([runningEvent, completedEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(items[0].event?.args?.file_path).toBe("src/main.ts");
    });

    it("keeps a later tool_result as the final visible result for a completed tool_call", () => {
      const callEvent = makeSessionEvent({
        id: "tool-call-read-1",
        action_type: "tool_call",
        function: "read_file",
        args: { path: "/repo-a/package.json" },
        result: { content: "{}" },
        callId: "call-read-1",
      });
      const resultEvent = makeSessionEvent({
        id: "tool-result-read-1",
        action_type: "tool_result",
        function: "read_file",
        args: {},
        result: { content: "{}", call_id: "call-read-1" },
        callId: "call-read-1",
      });

      const { items } = processChatItems([callEvent, resultEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(items.map((item) => item.event?.id)).toEqual([resultEvent.id]);
    });
  });

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

    it("does not count loading placeholder in stats", () => {
      const loadingEvent = makeSessionEvent({
        id: "loading",
        action_type: "tool_call",
        function: "read_file",
        result: {},
      });

      const { stats } = processChatItems([loadingEvent], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
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
