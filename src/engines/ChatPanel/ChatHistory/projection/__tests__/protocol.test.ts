import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getToolClassifierRegistrySnapshot } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";

import { projectChatHistory } from "../core";
import type {
  ApplyDeltaMessage,
  InitSnapshotMessage,
  ProjectionResponse,
} from "../protocol";
import { CHAT_PROJECTION_PROTOCOL_VERSION } from "../protocol";

function baseEvent(id: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "s",
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    functionName: id === "1" ? "user_message" : "agent_message",
    actionType: id === "1" ? "user" : "assistant",
    source: id === "1" ? "user" : "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    args: {},
    result: {},
  } as SessionEvent;
}

describe("chat projection protocol", () => {
  it("requires the complete stale-response identity tuple", () => {
    const request: InitSnapshotMessage = {
      type: "initSnapshot",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: "s",
      generation: 3,
      sourceVersion: 11,
      requestId: 19,
      events: [baseEvent("1")],
      options: {},
      toolRegistry: getToolClassifierRegistrySnapshot(),
    };
    const response: ProjectionResponse = {
      type: "projection",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      generation: request.generation,
      sourceVersion: request.sourceVersion,
      requestId: request.requestId,
      projectionRevision: 1,
      result: projectChatHistory(request.events),
      metrics: { queueWaitMs: 0, computeMs: 1, inputEvents: 1 },
    };
    expect(response).toMatchObject({
      sessionId: "s",
      generation: 3,
      sourceVersion: 11,
      requestId: 19,
    });
    expect(() => structuredClone(response)).not.toThrow();
  });

  it("encodes version continuity explicitly on deltas", () => {
    const request: ApplyDeltaMessage = {
      type: "applyDelta",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: "s",
      generation: 2,
      baseVersion: 6,
      sourceVersion: 7,
      requestId: 8,
      upserts: [baseEvent("2")],
      removedIds: [],
      eventIds: ["1", "2"],
      options: {},
    };
    expect(request.baseVersion + 1).toBe(request.sourceVersion);
    expect(() => structuredClone(request)).not.toThrow();
  });
});
