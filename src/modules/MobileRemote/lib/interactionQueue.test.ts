import { describe, expect, it } from "vitest";

import {
  countPermissionRequests,
  createInitialInteractionQueueState,
  dequeuePermissionRequest,
  peekPermissionRequest,
  reduceInteractionQueueFromBusEvent,
} from "./interactionQueue";

/** Flat wire shape broadcast by the managed CLI hook and the ACP bridge. */
function flatPermissionEvent(
  origin: "cli_hook" | "acp",
  overrides: Record<string, unknown> = {}
) {
  return {
    type: "permission:request",
    session_id: "s1",
    sessionId: "s1",
    requestId: origin === "acp" ? "acpperm-1" : "hookperm-1",
    toolName: "Bash",
    toolCallId: origin === "acp" ? "acpperm-1" : "hookperm-1",
    toolArgs: { command: "pnpm test" },
    origin,
    ...overrides,
  };
}

describe("interactionQueue", () => {
  it("enqueues permission requests once", () => {
    const envelope = {
      type: "permission:request",
      payload: {
        requestId: "p1",
        sessionId: "s1",
        toolName: "run_shell",
        toolArgs: { command: "pnpm test" },
      },
    };
    let state = createInitialInteractionQueueState();
    state = reduceInteractionQueueFromBusEvent(state, envelope);
    state = reduceInteractionQueueFromBusEvent(state, envelope);
    expect(state.queue).toHaveLength(1);
    expect(peekPermissionRequest(state)?.toolName).toBe("run_shell");
  });

  it("dequeues head", () => {
    let state = reduceInteractionQueueFromBusEvent(
      createInitialInteractionQueueState(),
      {
        type: "permission:request",
        payload: {
          requestId: "p1",
          sessionId: "s1",
          toolName: "run_shell",
          toolArgs: {},
        },
      }
    );
    state = dequeuePermissionRequest(state);
    expect(peekPermissionRequest(state)).toBeNull();
  });

  it.each(["cli_hook", "acp"] as const)(
    "enqueues the flat %s envelope that carries no payload wrapper",
    (origin) => {
      const state = reduceInteractionQueueFromBusEvent(
        createInitialInteractionQueueState(),
        flatPermissionEvent(origin)
      );
      expect(state.queue).toHaveLength(1);
      expect(peekPermissionRequest(state)).toEqual({
        requestId: origin === "acp" ? "acpperm-1" : "hookperm-1",
        sessionId: "s1",
        toolName: "Bash",
        toolCallId: origin === "acp" ? "acpperm-1" : "hookperm-1",
        toolArgs: { command: "pnpm test" },
        origin,
      });
    }
  );

  it("still deduplicates a flat envelope by requestId", () => {
    let state = createInitialInteractionQueueState();
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook")
    );
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook")
    );
    expect(state.queue).toHaveLength(1);
  });

  it("ignores a flat envelope missing the required identity fields", () => {
    const state = reduceInteractionQueueFromBusEvent(
      createInitialInteractionQueueState(),
      { type: "permission:request", session_id: "s1", origin: "cli_hook" }
    );
    expect(state.queue).toEqual([]);
  });

  it("dequeues the answered request rather than whatever is at the head", () => {
    let state = createInitialInteractionQueueState();
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook", { requestId: "hookperm-1" })
    );
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook", { requestId: "hookperm-2" })
    );
    state = dequeuePermissionRequest(state, "hookperm-2");
    expect(state.queue.map((row) => row.requestId)).toEqual(["hookperm-1"]);
    // A repeated answer for an already-removed id is a no-op.
    expect(dequeuePermissionRequest(state, "hookperm-2")).toBe(state);
  });

  it("drops a native prompt the desktop finalized", () => {
    let state = reduceInteractionQueueFromBusEvent(
      createInitialInteractionQueueState(),
      {
        type: "permission:request",
        payload: {
          requestId: "p1",
          sessionId: "s1",
          toolName: "run_shell",
          toolCallId: "call-1",
          toolArgs: {},
        },
      }
    );
    state = reduceInteractionQueueFromBusEvent(state, {
      type: "agent:interaction_finalized",
      payload: {
        sessionId: "s1",
        toolCallId: "call-other",
        status: "answered",
      },
    });
    expect(state.queue).toHaveLength(1);
    state = reduceInteractionQueueFromBusEvent(state, {
      type: "agent:interaction_finalized",
      payload: { sessionId: "s1", toolCallId: "call-1", status: "answered" },
    });
    expect(state.queue).toEqual([]);
  });

  it("scopes the visible prompt to the session the phone is viewing", () => {
    let state = createInitialInteractionQueueState();
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook", {
        session_id: "other",
        sessionId: "other",
        requestId: "hookperm-other",
      })
    );
    state = reduceInteractionQueueFromBusEvent(
      state,
      flatPermissionEvent("cli_hook", { requestId: "hookperm-mine" })
    );
    expect(peekPermissionRequest(state)?.requestId).toBe("hookperm-other");
    expect(peekPermissionRequest(state, "s1")?.requestId).toBe("hookperm-mine");
    expect(countPermissionRequests(state)).toBe(2);
    expect(countPermissionRequests(state, "s1")).toBe(1);
  });
});
