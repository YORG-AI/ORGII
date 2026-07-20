import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getToolClassifierRegistrySnapshot } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";

import type { ChatHistoryProjectionOptions } from "../core";
import type { ChatProjectionDelta } from "../delta";
import { buildProjectionDelta } from "../delta";
import {
  CHAT_PROJECTION_PROTOCOL_VERSION,
  type ChatProjectionRequest,
} from "../protocol";
import { ChatProjectionRuntime } from "../runtime";

function event(id: string, text = id): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "s",
    createdAt: `2026-01-01T00:00:${id.padStart(2, "0")}.000Z`,
    functionName: id === "1" ? "user_message" : "agent_message",
    actionType: id === "1" ? "user" : "assistant",
    source: id === "1" ? "user" : "assistant",
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    args: {},
    result: {},
  } as SessionEvent;
}

const envelope = {
  protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
  sessionId: "s",
  generation: 1,
};

function requestFromDelta(
  delta: ChatProjectionDelta,
  requestId: number,
  options: ChatHistoryProjectionOptions
): ChatProjectionRequest {
  const base = {
    ...envelope,
    baseVersion: delta.baseVersion,
    sourceVersion: delta.sourceVersion,
    requestId,
    options,
  };
  return delta.kind === "append"
    ? { ...base, type: "appendEvents", events: delta.appendedEvents }
    : {
        ...base,
        type: "applyDelta",
        upserts: delta.upserts,
        removedIds: delta.removedIds,
        eventIds: delta.eventIds,
      };
}

describe("ChatProjectionRuntime", () => {
  it("keeps snapshot and incremental delta projections equivalent", () => {
    const runtime = new ChatProjectionRuntime();
    const initial = [event("1"), event("2")];
    const next = [event("1"), event("2", "updated"), event("3")];
    const snapshot = runtime.handle({
      ...envelope,
      type: "initSnapshot",
      sourceVersion: 10,
      requestId: 1,
      events: initial,
      options: { groups: { turnGrouping: { mode: "standard" } } },
      toolRegistry: getToolClassifierRegistrySnapshot(),
    });
    expect(snapshot.type).toBe("projection");
    const delta = buildProjectionDelta(initial, next, 10, 11);
    const incremental = runtime.handle(
      requestFromDelta(delta, 2, {
        groups: { turnGrouping: { mode: "standard" } },
      })
    );

    const fresh = new ChatProjectionRuntime().handle({
      ...envelope,
      type: "initSnapshot",
      sourceVersion: 11,
      requestId: 3,
      events: next,
      options: { groups: { turnGrouping: { mode: "standard" } } },
      toolRegistry: getToolClassifierRegistrySnapshot(),
    });
    expect(incremental.type).toBe("projection");
    expect(fresh.type).toBe("projection");
    if (incremental.type === "projection" && fresh.type === "projection") {
      expect(incremental.result.optimizedChatHistory).toEqual(
        fresh.result.optimizedChatHistory
      );
      expect(incremental.result.groups).toEqual(fresh.result.groups);
    }
  });

  it("rejects generation mismatches and version gaps", () => {
    const runtime = new ChatProjectionRuntime();
    runtime.handle({
      ...envelope,
      type: "initSnapshot",
      sourceVersion: 4,
      requestId: 1,
      events: [event("1")],
      options: {},
      toolRegistry: getToolClassifierRegistrySnapshot(),
    });
    const staleGeneration = runtime.handle({
      ...envelope,
      generation: 2,
      type: "applyDelta",
      baseVersion: 4,
      sourceVersion: 5,
      requestId: 2,
      options: {},
      upserts: [],
      removedIds: [],
      eventIds: ["1"],
    });
    expect(staleGeneration).toMatchObject({
      type: "resyncRequired",
      reason: "generation-mismatch",
    });

    const gap = runtime.handle({
      ...envelope,
      type: "applyDelta",
      baseVersion: 3,
      sourceVersion: 5,
      requestId: 3,
      options: {},
      upserts: [],
      removedIds: [],
      eventIds: ["1"],
    });
    expect(gap).toMatchObject({
      type: "resyncRequired",
      reason: "version-gap",
      expectedBaseVersion: 4,
    });
  });

  it("applies new options atomically with a newer source version", () => {
    const runtime = new ChatProjectionRuntime();
    const initial = [event("1"), event("2"), event("3")];
    runtime.handle({
      ...envelope,
      type: "initSnapshot",
      sourceVersion: 20,
      requestId: 1,
      events: initial,
      options: {
        groups: {
          turnGrouping: { mode: "standard" },
          defaultTurnCollapsed: false,
        },
      },
      toolRegistry: getToolClassifierRegistrySnapshot(),
    });
    const next = [...initial, event("4")];
    const response = runtime.handle(
      requestFromDelta(buildProjectionDelta(initial, next, 20, 21), 2, {
        groups: {
          turnGrouping: { mode: "standard" },
          allTurnsCollapsed: true,
        },
      })
    );
    expect(response.type).toBe("projection");
    if (response.type === "projection") {
      expect(response.sourceVersion).toBe(21);
      expect(response.result.groups?.flatItems.length).toBeLessThan(
        response.result.optimizedChatHistory.length
      );
    }
  });

  it("evicts old sessions and asks them to resync", () => {
    const runtime = new ChatProjectionRuntime(1);
    for (const sessionId of ["a", "b"]) {
      runtime.handle({
        ...envelope,
        sessionId,
        type: "initSnapshot",
        sourceVersion: 1,
        requestId: sessionId === "a" ? 1 : 2,
        events: [{ ...event("1"), sessionId }],
        options: {},
        toolRegistry: getToolClassifierRegistrySnapshot(),
      });
    }
    const response = runtime.handle({
      ...envelope,
      sessionId: "a",
      type: "applyDelta",
      baseVersion: 1,
      sourceVersion: 2,
      requestId: 3,
      options: {},
      upserts: [],
      removedIds: [],
      eventIds: ["1"],
    });
    expect(response).toMatchObject({
      type: "resyncRequired",
      reason: "missing-session",
    });
  });
});
