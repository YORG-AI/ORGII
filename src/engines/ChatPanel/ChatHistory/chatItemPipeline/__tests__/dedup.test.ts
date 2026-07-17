import { beforeEach, describe, expect, it } from "vitest";

import {
  makeSessionEvent,
  resetActivityCounter,
} from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { buildDedupMaps, isAssistantMessageEvent } from "../dedup";

function makeRunningToolCall(
  functionName: string,
  overrides: Record<string, unknown> = {}
) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: functionName,
    result: { status: "running" },
    ...overrides,
  });
}

function makeCompletedToolCall(
  functionName: string,
  overrides: Record<string, unknown> = {}
) {
  return makeSessionEvent({
    action_type: "tool_call",
    function: functionName,
    result: { status: "completed", output: "done" },
    ...overrides,
  });
}

function makeAssistantMessage(
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return makeSessionEvent({
    action_type: "assistant",
    function: "assistant_message",
    displayVariant: "message",
    result: {
      content,
      observation: content,
      role: "assistant",
      is_delta: false,
    },
    ...overrides,
  });
}

function makeThinkingMessage(
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return makeSessionEvent({
    action_type: "llm_thinking",
    function: "thinking",
    displayVariant: "thinking",
    result: {
      content,
      observation: content,
      is_delta: false,
    },
    ...overrides,
  });
}

function makeUserMessage(
  content: string,
  overrides: Record<string, unknown> = {}
) {
  return makeSessionEvent({
    action_type: "raw",
    function: "user_message",
    source: "user",
    displayVariant: "message",
    displayText: content,
    result: { message: { content } },
    ...overrides,
  });
}

describe("isAssistantMessageEvent", () => {
  beforeEach(() => {
    resetActivityCounter();
  });

  it("does not classify turn_summary as the final assistant reply", () => {
    const summary = makeSessionEvent({
      action_type: "assistant",
      function: "turn_summary",
      uiCanonical: "turn_summary",
      displayVariant: "summary",
      displayStatus: "completed",
      result: { observation: "Summarized the turn." },
    });

    expect(isAssistantMessageEvent(summary)).toBe(false);
  });

  it("classifies normal assistant messages as assistant replies", () => {
    expect(isAssistantMessageEvent(makeAssistantMessage("Done."))).toBe(true);
  });
});

describe("buildDedupMaps", () => {
  beforeEach(() => {
    resetActivityCounter();
  });

  it("returns empty sets/maps for empty history", () => {
    const { runningChunksToSkip, runningArgsMap } = buildDedupMaps([]);
    expect(runningChunksToSkip.size).toBe(0);
    expect(runningArgsMap.size).toBe(0);
  });

  it("does not skip a single running tool_call with no completed match", () => {
    const running = makeRunningToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([running]);
    expect(runningChunksToSkip.size).toBe(0);
  });

  it("marks running chunk_id for skip when completed match exists", () => {
    const running = makeRunningToolCall("read_file");
    const completed = makeCompletedToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([running, completed]);
    expect(runningChunksToSkip.has(running.id)).toBe(true);
    expect(runningChunksToSkip.size).toBe(1);
  });

  it("treats displayStatus running tool calls as transient rows", () => {
    const running = makeSessionEvent({
      action_type: "tool_call",
      function: "edit_file",
      displayStatus: "running",
      result: {},
    });
    const completed = makeCompletedToolCall("edit_file");

    const { runningChunksToSkip } = buildDedupMaps([running, completed]);
    expect(runningChunksToSkip.has(running.id)).toBe(true);
  });

  it("skips completed tool-call rows when a matching result row exists", () => {
    const callId = "tool_123";
    const toolCall = makeSessionEvent({
      id: `tool-call-${callId}`,
      action_type: "tool_call",
      function: "edit_file",
      callId,
      args: { file_path: "note.md" },
      result: { observation: "Written note.md" },
      displayStatus: "completed",
    });
    const toolResult = makeSessionEvent({
      id: `tool-result-${callId}`,
      action_type: "tool_result",
      function: "edit_file",
      callId,
      args: {},
      result: { observation: "Written note.md" },
      displayStatus: "completed",
    });

    const { runningChunksToSkip, runningArgsMap } = buildDedupMaps([
      toolCall,
      toolResult,
    ]);
    expect(runningChunksToSkip.has(toolCall.id)).toBe(true);
    expect(runningChunksToSkip.has(toolResult.id)).toBe(false);
    expect(runningArgsMap.get(callId)).toEqual({ file_path: "note.md" });
  });

  it("handles multiple running/completed pairs with different functions", () => {
    const runningRead = makeRunningToolCall("read_file");
    const runningEdit = makeRunningToolCall("edit_file");
    const completedRead = makeCompletedToolCall("read_file");
    const completedEdit = makeCompletedToolCall("edit_file");

    const { runningChunksToSkip } = buildDedupMaps([
      runningRead,
      runningEdit,
      completedRead,
      completedEdit,
    ]);
    expect(runningChunksToSkip.has(runningRead.id)).toBe(true);
    expect(runningChunksToSkip.has(runningEdit.id)).toBe(true);
    expect(runningChunksToSkip.size).toBe(2);
  });

  it("does nothing when only completed events exist (no running)", () => {
    const completed1 = makeCompletedToolCall("read_file");
    const completed2 = makeCompletedToolCall("edit_file");

    const { runningChunksToSkip, runningArgsMap } = buildDedupMaps([
      completed1,
      completed2,
    ]);
    expect(runningChunksToSkip.size).toBe(0);
    expect(runningArgsMap.size).toBe(0);
  });

  it("stores args by callId in runningArgsMap", () => {
    const running = makeRunningToolCall("read_file", {
      callId: "call-abc",
      args: { file_path: "src/app.ts" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningArgsMap } = buildDedupMaps([running, completed]);
    expect(runningArgsMap.has("call-abc")).toBe(true);
    expect(runningArgsMap.get("call-abc")).toEqual({
      file_path: "src/app.ts",
    });
  });

  it("does not store args in runningArgsMap when call_id is missing", () => {
    const running = makeRunningToolCall("read_file", {
      args: { file_path: "src/app.ts" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningArgsMap } = buildDedupMaps([running, completed]);
    expect(runningArgsMap.size).toBe(0);
  });

  it("does not store args when args object is empty", () => {
    const running = makeRunningToolCall("read_file", {
      callId: "call-empty",
      args: {},
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningArgsMap } = buildDedupMaps([running, completed]);
    expect(runningArgsMap.has("call-empty")).toBe(false);
  });

  it("matches running to completed in FIFO order for same function", () => {
    const runningFirst = makeRunningToolCall("read_file");
    const runningSecond = makeRunningToolCall("read_file");
    const completedFirst = makeCompletedToolCall("read_file");
    const completedSecond = makeCompletedToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([
      runningFirst,
      runningSecond,
      completedFirst,
      completedSecond,
    ]);
    expect(runningChunksToSkip.has(runningFirst.id)).toBe(true);
    expect(runningChunksToSkip.has(runningSecond.id)).toBe(true);
    expect(runningChunksToSkip.size).toBe(2);
  });

  it("does not treat non-running tool_call as running", () => {
    const pending = makeSessionEvent({
      action_type: "tool_call",
      function: "read_file",
      result: { status: "pending" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([pending, completed]);
    expect(runningChunksToSkip.size).toBe(0);
  });

  it("requires id on running event to be tracked", () => {
    const runningNoId = makeSessionEvent({
      action_type: "tool_call",
      function: "read_file",
      id: "",
      result: { status: "running" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([runningNoId, completed]);
    expect(runningChunksToSkip.size).toBe(0);
  });

  it("does not skip running event when no completed event of same function follows", () => {
    const runningRead = makeRunningToolCall("read_file");
    const completedEdit = makeCompletedToolCall("edit_file");

    const { runningChunksToSkip } = buildDedupMaps([
      runningRead,
      completedEdit,
    ]);
    expect(runningChunksToSkip.has(runningRead.id)).toBe(false);
  });

  it("only matches completed events that appear AFTER the running event", () => {
    const completed = makeCompletedToolCall("read_file");
    const running = makeRunningToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([completed, running]);
    expect(runningChunksToSkip.size).toBe(0);
  });

  it("reads call_id from result.call_id as fallback", () => {
    const running = makeRunningToolCall("read_file", {
      args: { file_path: "test.ts" },
      result: { status: "running", call_id: "call-from-result" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningArgsMap } = buildDedupMaps([running, completed]);
    expect(runningArgsMap.has("call-from-result")).toBe(true);
  });

  it("ignores non-tool_call action types even with running status", () => {
    const nonToolCall = makeSessionEvent({
      action_type: "assistant",
      function: "read_file",
      result: { status: "running" },
    });
    const completed = makeCompletedToolCall("read_file");

    const { runningChunksToSkip } = buildDedupMaps([nonToolCall, completed]);
    expect(runningChunksToSkip.size).toBe(0);
  });
});

// ============================================
// Assistant Message Content Dedup
// ============================================

describe("buildDedupMaps — user message dedup", () => {
  beforeEach(() => {
    resetActivityCounter();
  });

  it("keeps persisted user message over matching optimistic user input", () => {
    const optimistic = makeUserMessage("Please do the task", {
      id: "user-input-123",
      result: {
        syntheticUserInput: true,
        message: { content: "Please do the task" },
      },
    });
    const persisted = makeUserMessage("Please do the task", {
      id: "user-message-456",
      result: {
        backendPersisted: true,
        message: { content: "Please do the task" },
      },
    });

    const { duplicateUserIds } = buildDedupMaps([optimistic, persisted]);

    expect(duplicateUserIds.has(optimistic.id)).toBe(true);
    expect(duplicateUserIds.has(persisted.id)).toBe(false);
  });

  it("does not treat user-input-prefixed backend events as optimistic echoes", () => {
    const first = makeUserMessage("Repeat this", {
      id: "user-input-backend-1",
      result: { message: { content: "Repeat this" } },
    });
    const second = makeUserMessage("Repeat this", {
      id: "user-message-2",
      result: { message: { content: "Repeat this" } },
    });

    const { duplicateUserIds } = buildDedupMaps([first, second]);

    expect(duplicateUserIds.has(first.id)).toBe(false);
    expect(duplicateUserIds.has(second.id)).toBe(false);
  });

  it("keeps repeated identical user messages across separate rounds", () => {
    const first = makeUserMessage("Repeat this", { id: "user-message-1" });
    const assistant = makeAssistantMessage("Done");
    const second = makeUserMessage("Repeat this", { id: "user-message-2" });

    const { duplicateUserIds } = buildDedupMaps([first, assistant, second]);

    expect(duplicateUserIds.has(first.id)).toBe(false);
    expect(duplicateUserIds.has(second.id)).toBe(false);
  });
});

describe("buildDedupMaps — assistant message dedup", () => {
  it("recognizes canonical agent messages even with a raw action type", () => {
    const event = makeSessionEvent({
      action_type: "raw_event",
      function: "assistant",
      uiCanonical: "agent_message",
      source: "assistant",
      displayVariant: "message",
      displayText: "Final reply",
      result: { content: "Final reply" },
    });

    expect(isAssistantMessageEvent(event)).toBe(true);
  });

  beforeEach(() => {
    resetActivityCounter();
  });

  it("returns empty duplicateAssistantIds for empty history", () => {
    const { duplicateAssistantIds } = buildDedupMaps([]);
    expect(duplicateAssistantIds.size).toBe(0);
  });

  it("does not deduplicate a single assistant message", () => {
    const msg = makeAssistantMessage("Hello world");
    const { duplicateAssistantIds } = buildDedupMaps([msg]);
    expect(duplicateAssistantIds.size).toBe(0);
  });

  it("deduplicates consecutive assistant messages with identical content", () => {
    const msg1 = makeAssistantMessage("Let me look at this project.");
    const msg2 = makeAssistantMessage("Let me look at this project.");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2]);
    expect(duplicateAssistantIds.size).toBe(1);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });

  it("keeps both messages when content differs", () => {
    const msg1 = makeAssistantMessage("First message");
    const msg2 = makeAssistantMessage("Second message");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2]);
    expect(duplicateAssistantIds.size).toBe(0);
  });

  it("deduplicates repeated assistant text across non-assistant events in one turn", () => {
    const msg1 = makeAssistantMessage("Same content");
    const toolCall = makeCompletedToolCall("read_file");
    const msg2 = makeAssistantMessage("Same content");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, toolCall, msg2]);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });

  it("handles three consecutive identical messages — keeps only the last", () => {
    const msg1 = makeAssistantMessage("Repeated");
    const msg2 = makeAssistantMessage("Repeated");
    const msg3 = makeAssistantMessage("Repeated");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2, msg3]);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg3.id)).toBe(false);
  });

  it("ignores whitespace-only content differences", () => {
    const msg1 = makeAssistantMessage("  Hello  ");
    const msg2 = makeAssistantMessage("Hello");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2]);
    expect(duplicateAssistantIds.size).toBe(1);
  });

  it("skips empty-content assistant messages", () => {
    const msg1 = makeAssistantMessage("");
    const msg2 = makeAssistantMessage("");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2]);
    expect(duplicateAssistantIds.size).toBe(0);
  });

  it("works with actionType=assistant and function=message", () => {
    const msg1 = makeSessionEvent({
      action_type: "assistant",
      function: "message",
      result: { content: "Same text", role: "assistant", is_delta: false },
    });
    const msg2 = makeSessionEvent({
      action_type: "assistant",
      function: "message",
      result: { content: "Same text", role: "assistant", is_delta: false },
    });

    const { duplicateAssistantIds } = buildDedupMaps([msg1, msg2]);
    expect(duplicateAssistantIds.size).toBe(1);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
  });

  it("deduplicates repeated assistant text while also deduplicating running tool calls", () => {
    const running = makeRunningToolCall("read_file");
    const msg1 = makeAssistantMessage("Hello");
    const completed = makeCompletedToolCall("read_file");
    const msg2 = makeAssistantMessage("Hello");

    const { runningChunksToSkip, duplicateAssistantIds } = buildDedupMaps([
      running,
      msg1,
      completed,
      msg2,
    ]);
    expect(runningChunksToSkip.has(running.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });

  it("deduplicates repeated thinking/message segment pairs", () => {
    const think1 = makeThinkingMessage("Can we chat?");
    const msg1 = makeAssistantMessage("可以。你想聊什么？");
    const think2 = makeThinkingMessage("Can we chat?");
    const msg2 = makeAssistantMessage("可以。你想聊什么？");

    const { duplicateAssistantIds } = buildDedupMaps([
      think1,
      msg1,
      think2,
      msg2,
    ]);

    expect(duplicateAssistantIds.has(think1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(think2.id)).toBe(false);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });

  it("deduplicates repeated assistant text within one user turn even around tools", () => {
    const msg1 = makeAssistantMessage("Reading the updated request.");
    const toolCall = makeCompletedToolCall("read_file");
    const msg2 = makeAssistantMessage("Reading the updated request.");

    const { duplicateAssistantIds } = buildDedupMaps([msg1, toolCall, msg2]);

    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });

  it("deduplicates repeated thinking text within one user turn even around tools", () => {
    const think1 = makeThinkingMessage("Need inspect file");
    const msg1 = makeAssistantMessage("I will inspect it.");
    const toolCall = makeCompletedToolCall("read_file");
    const think2 = makeThinkingMessage("Need inspect file");
    const msg2 = makeAssistantMessage("I will inspect it.");

    const { duplicateAssistantIds } = buildDedupMaps([
      think1,
      msg1,
      toolCall,
      think2,
      msg2,
    ]);

    expect(duplicateAssistantIds.has(think1.id)).toBe(true);
    expect(duplicateAssistantIds.has(msg1.id)).toBe(true);
    expect(duplicateAssistantIds.has(think2.id)).toBe(false);
    expect(duplicateAssistantIds.has(msg2.id)).toBe(false);
  });
});
