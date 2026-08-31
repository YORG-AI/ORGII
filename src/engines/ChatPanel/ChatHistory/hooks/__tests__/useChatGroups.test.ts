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
import {
  type ChatGroupMeta,
  isTurnCollapseEligible,
  isTurnPreviewItem,
  projectChatGroups,
  resolveTurnDefaultCollapsed,
} from "../useChatGroupsProjection";

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

/** Shape emitted by normalized Codex CLI and native-transcript error chunks. */
function cliErrorItem(message: string): OptimizedChatItem {
  return item(
    makeEvent({
      functionName: "error",
      actionType: "error",
      displayText: message,
      displayStatus: "failed",
      displayVariant: "error",
      result: { error: message, success: false },
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

function unloadedTurnPreviewItem(
  turnId: string,
  bodyEventCount: number,
  text: string
): OptimizedChatItem {
  const preview = unloadedTurnItem(turnId, bodyEventCount);
  preview.event!.functionName = "assistant";
  preview.event!.actionType = "assistant";
  preview.event!.source = "assistant";
  preview.event!.displayText = text;
  preview.event!.displayVariant = "message";
  preview.event!.args = { turnPreviewOnly: true };
  preview.event!.result = {
    ...preview.event!.result,
    observation: text,
    content: text,
  };
  return preview;
}

function flatTexts(items: OptimizedChatItem[]): string[] {
  return items.map((entry) => entry.event?.displayText ?? "");
}

describe("projectChatGroups", () => {
  it("matches the React hook adapter without requiring React state", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      assistantItem("first reply"),
      userItem("current turn"),
      assistantItem("current reply"),
    ];
    const options = { allTurnsCollapsed: true };

    const projected = projectChatGroups(history, options);
    const hooked = useChatGroups(history, options);

    expect(projected).toEqual(hooked);
  });

  it("accepts custom turn callbacks as plain function inputs", () => {
    const boundary = boundaryItem("new logical turn");
    const history = [toolItem(), boundary, assistantItem("reply")];

    const result = projectChatGroups(history, {
      disableTurnCollapse: true,
      isTurnBoundaryItem: (entry) => entry === boundary,
    });

    expect(result.groupHeaders).toEqual([null, boundary]);
    expect(result.groupCounts).toEqual([1, 1]);
  });
});

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
    // remains expanded while its round is still running.
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
    expect(result.groupMeta[0].assistantCopyEventIds).toEqual([]);
    expect(result.lastAssistantFlatIndexPerItem[0]).toBe(0);
    expect(flatTexts(result.flatItems)).toContain("unloaded final reply");
    expect(flatTexts(result.flatItems)).not.toContain("Turn is not loaded yet");
  });

  it("shows a final-reply preview carried by the unloaded-turn placeholder", () => {
    const firstTurn = userItem("first turn");
    const preview = unloadedTurnPreviewItem(
      firstTurn.event!.id,
      12,
      "bounded final reply"
    );
    const history = [
      firstTurn,
      preview,
      userItem("current turn"),
      assistantItem("current reply"),
    ];

    const result = useChatGroups(history);

    expect(isTurnPreviewItem(preview)).toBe(true);
    expect(result.groupMeta[0].unloadedTurn?.turnId).toBe(firstTurn.event!.id);
    expect(flatTexts(result.flatItems)).toContain("bounded final reply");
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

  it("keeps a normalized CLI error when its historical turn is collapsed", () => {
    const history = [
      userItem("first turn"),
      toolItem(),
      cliErrorItem("unexpected status 402 Payment Required"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    expect(flatTexts(result.flatItems)).toContain(
      "unexpected status 402 Payment Required"
    );
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

  it("keeps errors that precede the final reply", () => {
    const history = [
      userItem("first turn"),
      errorItem("transient blip"),
      assistantItem("recovered and finished"),
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    const texts = flatTexts(result.flatItems);
    expect(texts).toContain("Error: transient blip");
    expect(texts).toContain("recovered and finished");
    expect(result.groupCounts[0]).toBe(2);
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

  it("retains every assistant copy source when collapse hides earlier replies", () => {
    const firstUpdate = assistantItem("first update");
    const finalAnswer = assistantItem("final answer");
    const history = [
      userItem("first turn"),
      firstUpdate,
      toolItem(),
      finalAnswer,
      userItem("second turn"),
      assistantItem("second reply"),
    ];

    const result = useChatGroups(history, { allTurnsCollapsed: true });

    expect(flatTexts(result.flatItems)).not.toContain("first update");
    expect(result.groupMeta[0].assistantCopyEventIds).toEqual([
      firstUpdate.event?.id,
      finalAnswer.event?.id,
    ]);
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

describe("isTurnCollapseEligible — unloaded placeholder affordance", () => {
  function meta(overrides: Partial<ChatGroupMeta>): ChatGroupMeta {
    return {
      turnId: "turn-1",
      durationMs: 0,
      itemCount: 0,
      previewText: "",
      assistantCopyEventIds: [],
      startMs: null,
      endMs: null,
      unloadedTurn: null,
      ...overrides,
    };
  }

  it("keeps trivial loaded turns non-collapsible", () => {
    expect(isTurnCollapseEligible(meta({ itemCount: 1 }), 0, 3, {})).toBe(
      false
    );
    expect(isTurnCollapseEligible(meta({ itemCount: 2 }), 0, 3, {})).toBe(true);
  });

  it("shows the bar for any unloaded turn with a nonzero body surrogate", () => {
    // With turn pagination off, the collapse bar is the ONLY affordance that
    // can fetch an unloaded body — a 1-line body must still render it.
    const unloaded = meta({
      unloadedTurn: { turnId: "turn-1", bodyEventCount: 1 },
    });
    expect(isTurnCollapseEligible(unloaded, 0, 3, {})).toBe(true);
  });

  it("hides the bar only for measured-empty unloaded turns", () => {
    const empty = meta({
      unloadedTurn: { turnId: "turn-1", bodyEventCount: 0 },
    });
    expect(isTurnCollapseEligible(empty, 0, 3, {})).toBe(false);
  });

  it("shows the tail bar as soon as the round ends, with no wait or size threshold", () => {
    const smallTail = meta({ itemCount: 2 });
    // A running tail is never collapsible.
    expect(isTurnCollapseEligible(smallTail, 2, 3, {})).toBe(false);
    expect(
      isTurnCollapseEligible(smallTail, 2, 3, { tailTurnPhase: "running" })
    ).toBe(false);
    // A completed tail is eligible regardless of size.
    expect(
      isTurnCollapseEligible(smallTail, 2, 3, { tailTurnPhase: "complete" })
    ).toBe(true);
    expect(
      isTurnCollapseEligible(smallTail, 2, 3, { tailTurnPhase: "stale" })
    ).toBe(true);
  });

  it("still hides the bar for a trivial completed tail", () => {
    expect(
      isTurnCollapseEligible(meta({ itemCount: 1 }), 2, 3, {
        tailTurnPhase: "complete",
      })
    ).toBe(false);
  });

  it("resolves the shared default-collapse decision per phase", () => {
    // Non-tail turns default to collapsed.
    expect(resolveTurnDefaultCollapsed(false, {})).toBe(true);
    // A fresh completed tail stays expanded…
    expect(
      resolveTurnDefaultCollapsed(true, { tailTurnPhase: "complete" })
    ).toBe(false);
    // …until the session goes stale.
    expect(resolveTurnDefaultCollapsed(true, { tailTurnPhase: "stale" })).toBe(
      true
    );
    // An explicit expanded-by-default surface wins over everything.
    expect(
      resolveTurnDefaultCollapsed(true, {
        defaultTurnCollapsed: false,
        tailTurnPhase: "stale",
      })
    ).toBe(false);
  });
});

describe("projectChatGroups — completed tail turn", () => {
  function history(): OptimizedChatItem[] {
    return [
      userItem("first turn"),
      toolItem(),
      assistantItem("first reply"),
      userItem("current turn"),
      toolItem(),
      assistantItem("current reply"),
    ];
  }

  it("keeps the completed tail expanded by default", () => {
    const result = projectChatGroups(history(), { tailTurnPhase: "complete" });

    // Bar-eligible, but the tail's default stays expanded until the session
    // goes stale.
    expect(result.groupCounts).toEqual([1, 2]);
    expect(flatTexts(result.flatItems)).toEqual([
      "first reply",
      "run_shell",
      "current reply",
    ]);
  });

  it("honors an explicit collapse override on the completed tail", () => {
    const items = history();
    const tailTurnId = items[3].event!.id;

    const result = projectChatGroups(items, {
      tailTurnPhase: "complete",
      collapseOverrides: new Map([[tailTurnId, true]]),
    });

    expect(result.groupCounts).toEqual([1, 1]);
    expect(flatTexts(result.flatItems)).toEqual([
      "first reply",
      "current reply",
    ]);
  });

  it("ignores a tail collapse override while the round is still running", () => {
    const items = history();
    const tailTurnId = items[3].event!.id;

    const result = projectChatGroups(items, {
      collapseOverrides: new Map([[tailTurnId, true]]),
    });

    // A running tail is not collapse-eligible at all.
    expect(result.groupCounts).toEqual([1, 2]);
  });

  it("defaults a stale tail to collapsed regardless of size", () => {
    const result = projectChatGroups(history(), { tailTurnPhase: "stale" });

    expect(result.groupCounts).toEqual([1, 1]);
    expect(flatTexts(result.flatItems)).toEqual([
      "first reply",
      "current reply",
    ]);
  });

  it("lets an explicit expand override beat the stale default", () => {
    const items = history();
    const tailTurnId = items[3].event!.id;

    const result = projectChatGroups(items, {
      tailTurnPhase: "stale",
      collapseOverrides: new Map([[tailTurnId, false]]),
    });

    expect(result.groupCounts).toEqual([1, 2]);
    expect(flatTexts(result.flatItems)).toEqual([
      "first reply",
      "run_shell",
      "current reply",
    ]);
  });
});
