/**
 * useChatGroups — turn-collapse survivor tests.
 *
 * Focus: the structural collapse transform must keep terminal error cards
 * (quota exhausted / rate limited / stream retry budget exhausted) visible.
 * Regression coverage for the "quota error renders as blank space" bug
 * (2026-06-10): a collapsed turn whose tail was tool calls + error event
 * previously dropped the error and survived as a structural-only row.
 *
 * Runs in the node environment by mocking React's useMemo as a
 * pass-through (same pattern as useWebviewCommands.test.ts — the host
 * project doesn't ship @testing-library/react).
 */
import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { OptimizedChatItem } from "../../chatItemPipeline/types";
import { useChatGroups } from "../useChatGroups";

vi.mock("react", () => ({
  useMemo: <Value>(factory: () => Value) => factory(),
}));

let counter = 0;

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  counter++;
  return {
    id: `event-${counter}`,
    chunk_id: `event-${counter}`,
    sessionId: "session-test",
    createdAt: `2026-06-10T10:00:${String(counter).padStart(2, "0")}Z`,
    functionName: "read_file",
    uiCanonical: "",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  } as SessionEvent;
}

function item(event: SessionEvent): OptimizedChatItem {
  return { chunk_id: event.id, type: "activity", event };
}

function userItem(text: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "user_message",
      actionType: "raw",
      source: "user",
      displayText: text,
      displayVariant: "message",
    })
  );
}

function toolItem(): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "run_shell",
      actionType: "tool_call",
      displayText: "run_shell",
    })
  );
}

function assistantItem(text: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "assistant_message",
      actionType: "assistant",
      displayText: text,
      displayVariant: "message",
      result: { content: text },
    })
  );
}

function canonicalAgentMessageItem(text: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "assistant",
      uiCanonical: "agent_message",
      actionType: "raw_event",
      source: "assistant",
      displayText: text,
      displayVariant: "message",
      result: { content: text },
    })
  );
}

/** Shape stamped by Rust build_session_error_event / FE makeErrorEvent. */
function errorItem(message: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "system",
      actionType: "assistant",
      displayText: `Error: ${message}`,
      displayStatus: "failed",
      displayVariant: "message",
      result: { observation: `Error: ${message}` },
    })
  );
}

/** Shape stamped by persistedMessageToSessionEvent for a compact-boundary row. */
function boundaryItem(summary: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "context_compacted",
      uiCanonical: "context_compacted",
      actionType: "system",
      source: "system",
      displayText: summary,
      displayVariant: "message",
      result: { observation: summary, compactedCount: 6 },
    })
  );
}

function unloadedTurnItem(
  turnId: string,
  bodyEventCount: number
): OptimizedChatItem {
  return item(
    makeEvent({
      id: `turn-placeholder-${turnId}`,
      functionName: "turn_placeholder",
      uiCanonical: "turn_placeholder",
      actionType: "turn_placeholder",
      displayText: "Turn is not loaded yet",
      result: {
        unloadedTurn: {
          turnId,
          bodyEventCount,
          durationMs: 20_000,
        },
      },
    })
  );
}

function turnPreviewItem(text: string): OptimizedChatItem {
  const preview = canonicalAgentMessageItem(text);
  preview.event!.args = { turnPreviewOnly: true };
  return preview;
}

function flatTexts(items: OptimizedChatItem[]): string[] {
  return items.map((entry) => entry.event?.displayText ?? "");
}

describe("useChatGroups collapse — terminal error survival", () => {
  it("collapses completed historical turns by default", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      assistantItem("first reply"),
      userItem("current turn"),
      toolItem(),
      assistantItem("current reply"),
    ];

    const result = useChatGroups(history);

    // The prior turn defaults to the compact summary, while the live tail
    // remains expanded until it becomes eligible after the idle delay.
    expect(result.groupCounts).toEqual([1, 2]);
    expect(flatTexts(result.flatItems)).toEqual([
      "first reply",
      "run_shell",
      "current reply",
    ]);
  });

  it("keeps a canonical agent message outside a collapsed historical turn", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      canonicalAgentMessageItem("canonical final reply"),
      userItem("current turn"),
      assistantItem("current reply"),
    ];

    const result = useChatGroups(history);

    expect(result.groupCounts).toEqual([1, 1]);
    expect(flatTexts(result.flatItems)).toEqual([
      "canonical final reply",
      "current reply",
    ]);
  });

  it("shows a final-reply preview while the historical turn body stays unloaded", () => {
    const firstTurn = userItem("first turn");
    const history = [
      firstTurn,
      turnPreviewItem("unloaded final reply"),
      unloadedTurnItem(firstTurn.event!.id, 12),
      userItem("current turn"),
      assistantItem("current reply"),
    ];

    const result = useChatGroups(history);

    expect(result.groupMeta[0].unloadedTurn?.turnId).toBe(firstTurn.event!.id);
    expect(flatTexts(result.flatItems)).toContain("unloaded final reply");
    expect(flatTexts(result.flatItems)).not.toContain("Turn is not loaded yet");
  });

  it("keeps the error card when a collapsed turn has no completed assistant reply", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      toolItem(),
      errorItem("rate limit exceeded"),
      // Second turn makes turn 1 a non-tail, collapse-eligible group;
      // `allTurnsCollapsed` folds it (the collapse-all / pin-bar state).
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    expect(texts).toContain("Error: rate limit exceeded");
    // Tool calls are dropped by the collapse.
    expect(texts.filter((text) => text === "run_shell")).toHaveLength(0);
    // No structural-only placeholder for turn 1 — the error IS the survivor.
    expect(result.flatItems.some((entry) => entry.structuralOnly)).toBe(false);
  });

  it("keeps both the final reply and the trailing error in a collapsed turn", () => {
    const history = [
      userItem("first turn"),
      assistantItem("found the bug"),
      toolItem(),
      errorItem("credit balance too low"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    expect(texts).toContain("found the bug");
    expect(texts).toContain("Error: credit balance too low");
    expect(result.groupCounts[0]).toBe(2);
  });

  it("does not resurrect errors that precede the final reply", () => {
    const history = [
      userItem("first turn"),
      errorItem("transient blip"),
      assistantItem("recovered and finished"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    // The turn recovered: the pre-reply error stays collapsed away.
    expect(texts).not.toContain("Error: transient blip");
    expect(texts).toContain("recovered and finished");
    expect(result.groupCounts[0]).toBe(1);
  });

  it("collapses to the last reply only when the turn has no errors", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      assistantItem("all done"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    expect(result.groupCounts[0]).toBe(1);
    expect(flatTexts(result.flatItems)).toContain("all done");
  });

  it("maps dropped items to the surviving error's flat index", () => {
    const history = [
      userItem("first turn"), // orig 0 (header)
      toolItem(), // orig 1 (dropped)
      errorItem("quota gone"), // orig 2 (survivor, flat 0)
      userItem("second turn"), // orig 3 (header)
      assistantItem("second reply"), // orig 4 (flat 1)
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    expect(result.flatItems[0]?.event?.displayText).toBe("Error: quota gone");
    expect(result.originalToFlatIndex.get(1)).toBe(0);
    expect(result.originalToFlatIndex.get(2)).toBe(0);
    expect(result.totalFlatItems).toBe(2);
  });

  it("keeps the compact-boundary marker visible when a collapsed turn folds", () => {
    // A context-compaction boundary is appended as the trailing system row
    // of the round it followed. Collapsing that round must not drop it.
    const history = [
      userItem("first turn"),
      assistantItem("read the file"),
      toolItem(),
      assistantItem("final reply"),
      boundaryItem("earlier conversation summary"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    // `allTurnsCollapsed` force-collapses every eligible (multi-item, non-tail)
    // turn, exactly the state a user reaches via collapse-all or the pin-bar.
    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    // The final assistant reply and the boundary both survive the collapse.
    expect(texts).toContain("final reply");
    expect(texts).toContain("earlier conversation summary");
    // Intermediate narration/tool calls are still folded away.
    expect(texts.filter((text) => text === "run_shell")).toHaveLength(0);
    expect(result.groupCounts[0]).toBe(2);
  });

  it("keeps a boundary-only collapsed turn (no completed reply) visible", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      boundaryItem("summary without a trailing reply"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    expect(texts).toContain("summary without a trailing reply");
    expect(texts.filter((text) => text === "run_shell")).toHaveLength(0);
    expect(result.flatItems.some((entry) => entry.structuralOnly)).toBe(false);
  });

  it("keeps errors visible in expanded (non-collapsed) turns untouched", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      errorItem("rate limit exceeded"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const firstTurnId = history[0].event!.id;
    const result = useChatGroups(history, {
      collapseOverrides: new Map([[firstTurnId, false]]),
    });

    const texts = flatTexts(result.flatItems);
    expect(texts).toContain("Error: rate limit exceeded");
    expect(texts.filter((text) => text === "run_shell")).toHaveLength(1);
  });
});
