/**
 * Core pipeline tests: pass-through, assistant/plan handling, and deduplication.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { processChatItems } from "../pipeline";
import { makeShellItem } from "./pipeline.testUtils";

beforeEach(() => {
  resetActivityCounter();
});

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

  describe("chunk_id uniqueness", () => {
    it("disambiguates two tool_call events that share a callId", () => {
      // Imported transcripts can re-emit the same call_id (see the
      // `pending_tool_calls` re-insert in the Rust claude_code history
      // reader). buildDedupMaps only collapses a tool_call/tool_result *pair*,
      // so both events survive and getStableActivityItemId maps them onto the
      // same `tool:<sessionId>:<callId>` id — a duplicate React key.
      const first = makeSessionEvent({
        id: "tool-call-dup-a",
        action_type: "tool_call",
        function: "read_file",
        args: { path: "/repo/a.ts" },
        result: { content: "a" },
        callId: "toolu_duplicated",
      });
      const second = makeSessionEvent({
        id: "tool-call-dup-b",
        action_type: "tool_call",
        function: "read_file",
        args: { path: "/repo/b.ts" },
        result: { content: "b" },
        callId: "toolu_duplicated",
      });

      const { items } = processChatItems([first, second], {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      // Neither event is dropped, and the keys are unique.
      expect(items.map((item) => item.event?.id)).toEqual([
        first.id,
        second.id,
      ]);
      const chunkIds = items.map((item) => item.chunk_id);
      expect(new Set(chunkIds).size).toBe(chunkIds.length);
    });

    it("leaves chunk_ids untouched when they are already unique", () => {
      const events = [
        makeShellItem("echo one"),
        makeShellItem("echo two"),
        makeShellItem("echo three"),
      ];

      const { items } = processChatItems(events, {
        preFilterEmptyActivities: false,
        groupActionSummaries: false,
        groupReadFileActivities: false,
      });

      expect(items.every((item) => !item.chunk_id.includes("#"))).toBe(true);
    });
  });
});
