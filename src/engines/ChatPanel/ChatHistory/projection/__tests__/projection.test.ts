import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { projectChatHistory } from "../core";
import { buildProjectionDelta } from "../delta";
import { CHAT_PROJECTION_PROTOCOL_VERSION } from "../protocol";

function event(
  id: string,
  source: "user" | "assistant" = "assistant",
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "session-a",
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    functionName: source === "user" ? "user_message" : "agent_message",
    actionType: source,
    source,
    displayText: `${source}-${id}`,
    displayStatus: "completed",
    displayVariant: "message",
    args: {},
    result: {},
    ...overrides,
  } as SessionEvent;
}

function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries()).sort(([left], [right]) =>
      String(left).localeCompare(String(right))
    );
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  }
  return value;
}

describe("chat projection core", () => {
  it("does not mutate EventStore inputs while merging running args", () => {
    const running = event("1", "assistant", {
      actionType: "tool_call",
      functionName: "read_file",
      callId: "call-1",
      displayStatus: "running",
      displayVariant: "tool_call",
      args: { file_path: "a.ts" },
    });
    const completed = event("2", "assistant", {
      actionType: "tool_call",
      functionName: "read_file",
      callId: "call-1",
      displayVariant: "tool_call",
      args: {},
    });
    const originalArgs = completed.args;
    projectChatHistory([running, completed]);
    expect(completed.args).toBe(originalArgs);
    expect(completed.args).toEqual({});
  });

  it("produces structured-clone-safe serializable policies", () => {
    const options = {
      selectedThreadId: null,
      skipPolicy: "none" as const,
      groups: {
        turnGrouping: { mode: "standard" as const },
        defaultTurnCollapsed: true,
      },
    };
    expect(() => structuredClone(options)).not.toThrow();
    expect(CHAT_PROJECTION_PROTOCOL_VERSION).toBe(3);
  });

  it("keeps errors pinned when a completed turn is collapsed", () => {
    const events = [
      event("1", "user"),
      event("2", "assistant"),
      event("3", "assistant", {
        actionType: "system",
        functionName: "system",
        displayVariant: "message",
        displayStatus: "failed",
        displayText: "quota exhausted",
        result: { success: false, error: "quota exhausted" },
      }),
      event("4", "user"),
      event("5", "assistant"),
    ];
    const projected = projectChatHistory(events, {
      groups: {
        turnGrouping: { mode: "standard" },
        allTurnsCollapsed: true,
      },
    });
    const texts = projected.groups?.flatItems.map(
      (item) => item.event?.displayText
    );
    expect(texts).toContain("quota exhausted");
  });

  it("remains stable for a 50,000-event pressure fixture", () => {
    const events: SessionEvent[] = [];
    for (let index = 0; index < 25_000; index++) {
      events.push(event(String(index * 2), "user"));
      events.push(event(String(index * 2 + 1), "assistant"));
    }
    const projected = projectChatHistory(events, {
      groups: { turnGrouping: { mode: "standard" } },
    });
    expect(projected.optimizedChatHistory.length).toBeGreaterThan(0);
    expect(projected.groups?.groupMeta).toHaveLength(25_000);
    expect(projected.itemShapeDigest).not.toBe("0");
  }, 20_000);

  it("is deterministic for a 10,000-event fixture", () => {
    const events: SessionEvent[] = [];
    for (let index = 0; index < 5_000; index++) {
      events.push(event(String(index * 2), "user"));
      events.push(event(String(index * 2 + 1), "assistant"));
    }
    const options = {
      groups: { turnGrouping: { mode: "standard" as const } },
    };
    const first = normalize(projectChatHistory(events, options));
    const second = normalize(projectChatHistory(events, options));
    expect(second).toEqual(first);
  });
});

describe("projection deltas", () => {
  it("reports upserts, removals and canonical order", () => {
    const first = event("1", "user");
    const removed = event("2");
    const updated = event("3", "assistant", { displayText: "before" });
    const nextUpdated = { ...updated, displayText: "after" };
    const added = event("4");
    const delta = buildProjectionDelta(
      [first, removed, updated],
      [first, nextUpdated, added],
      7,
      8
    );
    expect(delta.baseVersion).toBe(7);
    expect(delta.sourceVersion).toBe(8);
    expect(delta.removedIds).toEqual(["2"]);
    expect(delta.upserts.map((item) => item.id)).toEqual(["3", "4"]);
    expect(delta.eventIds).toEqual(["1", "3", "4"]);
  });

  it("upserts an event whenever its immutable snapshot object changes", () => {
    const first = event("1", "user");
    const updated = event("3", "assistant", { displayText: "before" });
    const nextUpdated = {
      ...updated,
      source: "system",
      functionName: "system",
      uiCanonical: "context_compacted",
      args: { action: "compact", nested: { value: 2 } },
      result: { content: "after" },
    } as SessionEvent;
    const delta = buildProjectionDelta(
      [first, updated],
      [first, nextUpdated],
      8,
      9
    );
    expect(delta.upserts).toEqual([nextUpdated]);
  });

  it("does not upsert unchanged event objects", () => {
    const first = event("1", "user");
    const second = event("2");
    const delta = buildProjectionDelta([first, second], [first, second], 9, 10);
    expect(delta.upserts).toEqual([]);
  });

  it("changes the layout digest when a stable item id changes height", () => {
    const before = projectChatHistory([
      event("1", "user"),
      event("2", "assistant", { displayText: "short" }),
    ]);
    const after = projectChatHistory([
      event("1", "user"),
      event("2", "assistant", {
        displayText: "a much longer assistant message that changes row height",
      }),
    ]);
    expect(after.itemShapeDigest).not.toBe(before.itemShapeDigest);
  });
});
