import { describe, expect, it } from "vitest";

import {
  createInitialInteractionQueueState,
  dequeuePermissionRequest,
  peekPermissionRequest,
  reduceInteractionQueueFromBusEvent,
} from "./interactionQueue";

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
});
