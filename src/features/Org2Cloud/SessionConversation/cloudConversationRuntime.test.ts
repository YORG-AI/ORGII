import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session";

import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  type CloudConversationContextDeps,
  loadCloudConversationInitialContext,
} from "./cloudConversationRuntime";

function event(
  id: string,
  source: "user" | "assistant",
  text: string,
  turnIntentId?: string
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "root",
    createdAt: "2026-08-25T00:00:00.000Z",
    source,
    displayText: text,
    args: {},
    result: turnIntentId ? { turnIntentId } : {},
  } as SessionEvent;
}

function row(
  seq: number,
  turnId: string,
  author: string,
  inner: SessionEvent
): CloudConversationEvent {
  return {
    id: `row-${seq}`,
    rootSessionId: "root",
    authorUserId: author.toLowerCase(),
    authorDisplayName: author,
    turnId,
    seq,
    event: inner,
    createdAt: inner.createdAt,
  };
}

describe("cloud conversation runtime context", () => {
  it("loads and attributes the initial plane once while excluding redelivery", async () => {
    const priorUser = event("prior-user", "user", "please review", "prior");
    const excluded = event(
      "redelivered-user",
      "user",
      "same request",
      "current"
    );
    const rootHistory = event("root-answer", "assistant", "earlier answer");
    const deps: CloudConversationContextDeps = {
      getAccessToken: vi.fn(async () => "jwt"),
      getAuth: () => ({ userId: "viewer", supabaseUrl: "https://cloud" }),
      getSessions: () => [{ session_id: "root", name: "Root" } as Session],
      loadPlane: vi.fn(async () => ({
        events: [
          row(8, "prior", "Alice", priorUser),
          row(9, "current", "Viewer", excluded),
        ],
        lastSeq: 9,
      })),
      loadPersistedEvents: vi.fn(async () => [rootHistory]),
    };

    const context = await loadCloudConversationInitialContext(
      {
        orgId: "org",
        rootSessionId: "root",
        streamSessionId: "surface",
        excludeTurnIntentId: "current",
      },
      deps
    );

    expect(context.timeline.map((item) => item.displayText)).toEqual([
      "earlier answer",
      "please review",
    ]);
    const planeUser = context.timeline.find(
      (item) => item.displayText === "please review"
    );
    expect(context.senders?.get(planeUser?.id ?? "")).toBe("Alice");
    expect(context.readThroughPlaneSeq).toBe(9);
    expect(deps.loadPlane).toHaveBeenCalledWith("jwt", {
      orgId: "org",
      rootSessionId: "root",
      afterSeq: 0,
      retainLast: 60,
    });
    expect(deps.loadPersistedEvents).toHaveBeenCalledWith("root");
  });
});
