import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";

import {
  adoptAcceptedUserIntent,
  appendOptimisticQueueUserDelivery,
  confirmUserIntentPreparation,
  dispatchUserIntent,
  optimisticQueueUserEventId,
  prepareUserIntent,
  removeOptimisticQueueUserDelivery,
  setOptimisticQueueUserDelivery,
  settleUserIntentLifecycle,
} from "./userIntentDispatch";

const mocks = vi.hoisted(() => {
  const atomValues = new Map<unknown, unknown>();
  const store = {
    get: vi.fn((atom: unknown) => atomValues.get(atom)),
    set: vi.fn((atom: unknown, update: unknown) => {
      const previous = atomValues.get(atom);
      atomValues.set(
        atom,
        typeof update === "function"
          ? (update as (value: unknown) => unknown)(previous)
          : update
      );
    }),
  };
  return {
    atomValues,
    store,
    append: vi.fn(),
    getPersistedEvents: vi.fn(),
    removeByIdPrefix: vi.fn(),
    updateById: vi.fn(),
    sendMessage: vi.fn(),
    beginOptimisticTurn: vi.fn(),
    failOptimisticTurn: vi.fn(),
    beginTurnDispatch: vi.fn(),
    confirmTurnRunning: vi.fn(),
    markTurnTerminal: vi.fn(),
    markSessionActive: vi.fn(),
    publishTurnIntentDispatch: vi.fn(),
    createSyntheticUserEvent: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: mocks.append,
    getPersistedEvents: mocks.getPersistedEvents,
    removeByIdPrefix: mocks.removeByIdPrefix,
    updateById: mocks.updateById,
  },
}));

vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: mocks.sendMessage },
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
  failOptimisticTurn: mocks.failOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", () => ({
  beginTurnDispatch: mocks.beginTurnDispatch,
  confirmTurnRunning: mocks.confirmTurnRunning,
  markTurnTerminal: mocks.markTurnTerminal,
}));

vi.mock("@src/engines/SessionCore/control/turnIntentDispatchLifecycle", () => ({
  publishTurnIntentDispatch: mocks.publishTurnIntentDispatch,
}));

vi.mock("@src/store/session", () => ({
  markSessionActive: mocks.markSessionActive,
}));

vi.mock("@src/util/session/sessionDispatch", () => ({
  isCursorIdeSession: () => false,
}));

vi.mock("@src/engines/SessionCore/sync/adapters/shared/eventFactories", () => ({
  createSyntheticUserEvent: mocks.createSyntheticUserEvent,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => mocks.store,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

function syntheticEvent(sessionId: string, id: string) {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt: "2026-08-30T00:00:00.000Z",
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {},
    source: "user",
    displayText: "hello",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as const;
}

describe("userIntentDispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.atomValues.clear();
    mocks.beginTurnDispatch.mockReturnValue(7);
    mocks.append.mockResolvedValue(undefined);
    mocks.getPersistedEvents.mockResolvedValue([]);
    mocks.removeByIdPrefix.mockResolvedValue(1);
    mocks.updateById.mockResolvedValue(true);
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.createSyntheticUserEvent.mockImplementation((sessionId: string) =>
      syntheticEvent(sessionId, `user-${sessionId}`)
    );
  });

  it("keeps one queue-owned EventStore row through pending, failed, and cleanup", async () => {
    mocks.createSyntheticUserEvent.mockImplementation(
      (
        sessionId: string,
        visibleText: string,
        options: Record<string, unknown>
      ) => ({
        ...syntheticEvent(sessionId, String(options.id)),
        displayText: visibleText,
        displayStatus:
          options.deliveryStatus === "failed"
            ? "failed"
            : options.deliveryStatus === "sent"
              ? "completed"
              : "pending",
        result: {
          message: { content: visibleText, role: "user" },
          images: options.imageDataUrls,
          turnIntentId: options.turnIntentId,
          deliveryStatus: options.deliveryStatus,
          deliveryError: options.deliveryError,
          queueMessageId: options.queueMessageId,
          syntheticUserInput: true,
        },
      })
    );
    const params = {
      sessionId: "imported-session",
      visibleText: "@teammate inspect this",
      imageDataUrls: ["data:image/png;base64,a"],
      turnIntentId: "intent-canonical",
      queueMessageId: "queue-canonical",
      createdAt: "2026-08-30T01:02:03.000Z",
    };

    const pending = await appendOptimisticQueueUserDelivery(params);
    expect(pending).toMatchObject({
      id: optimisticQueueUserEventId("queue-canonical"),
      displayText: "@teammate inspect this",
      result: {
        images: ["data:image/png;base64,a"],
        deliveryStatus: "pending",
        turnIntentId: "intent-canonical",
        queueMessageId: "queue-canonical",
      },
    });
    expect(mocks.append).toHaveBeenCalledWith([pending], "imported-session");

    await expect(
      setOptimisticQueueUserDelivery(params, "failed", new Error("offline"))
    ).resolves.toBe(true);
    expect(mocks.updateById).toHaveBeenCalledWith(
      optimisticQueueUserEventId("queue-canonical"),
      expect.objectContaining({
        displayStatus: "failed",
        result: expect.objectContaining({
          message: { content: "@teammate inspect this", role: "user" },
          images: ["data:image/png;base64,a"],
          deliveryStatus: "failed",
          deliveryError: "offline",
        }),
      }),
      "imported-session"
    );

    await expect(
      setOptimisticQueueUserDelivery(
        { ...params, turnIntentId: "intent-retry" },
        "pending"
      )
    ).resolves.toBe(true);
    await expect(
      setOptimisticQueueUserDelivery(
        { ...params, turnIntentId: "intent-retry" },
        "sent"
      )
    ).resolves.toBe(true);
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(mocks.updateById).toHaveBeenNthCalledWith(
      2,
      optimisticQueueUserEventId("queue-canonical"),
      expect.objectContaining({
        displayText: "@teammate inspect this",
        displayStatus: "pending",
        result: expect.objectContaining({
          images: ["data:image/png;base64,a"],
          deliveryStatus: "pending",
          turnIntentId: "intent-retry",
        }),
      }),
      "imported-session"
    );
    expect(mocks.updateById).toHaveBeenNthCalledWith(
      3,
      optimisticQueueUserEventId("queue-canonical"),
      expect.objectContaining({
        displayText: "@teammate inspect this",
        displayStatus: "completed",
        result: expect.objectContaining({
          images: ["data:image/png;base64,a"],
          deliveryStatus: "sent",
          turnIntentId: "intent-retry",
        }),
      }),
      "imported-session"
    );

    await removeOptimisticQueueUserDelivery(params);
    expect(mocks.removeByIdPrefix).toHaveBeenCalledWith(
      optimisticQueueUserEventId("queue-canonical"),
      "imported-session"
    );
  });

  it("adopts an accepted turn through the shared intent/generation mapping", () => {
    const adopted = adoptAcceptedUserIntent({
      sessionId: "cliagent-recovered",
      turnIntentId: "intent-recovered",
      runtimeStatusSource: "dispatch",
    });

    expect(adopted).toEqual({
      sessionId: "cliagent-recovered",
      turnIntentId: "intent-recovered",
      generation: 7,
      runtimeStatusSource: "dispatch",
    });
    expect(mocks.beginTurnDispatch).toHaveBeenCalledOnce();
    expect(mocks.publishTurnIntentDispatch).toHaveBeenCalledWith(
      "intent-recovered",
      { sessionId: "cliagent-recovered", generation: 7 }
    );
    expect(mocks.beginOptimisticTurn).toHaveBeenCalledWith(
      "cliagent-recovered",
      "dispatch"
    );
    expect(mocks.confirmTurnRunning).toHaveBeenCalledWith("cliagent-recovered");

    settleUserIntentLifecycle(adopted, "completed");
    expect(mocks.markTurnTerminal).toHaveBeenCalledWith(
      "cliagent-recovered",
      "completed",
      { generation: 7 }
    );
  });

  it("owns the complete direct-dispatch lifecycle and exact send payload", async () => {
    const result = await dispatchUserIntent({
      sessionId: "cliagent-1",
      visibleText: "visible",
      imageDataUrls: ["data:image/png;base64,a"],
      runtimeStatusSource: "dispatch",
      send: {
        content: "agent-facing",
        displayText: "visible",
        model: "gpt-5.6-sol",
        accountId: "account-1",
        mode: "build",
        clientMessageId: "direct:1",
        turnIntentId: "intent-1",
        turnIntentSource: "user_submit",
        directUserIntent: true,
        allowNativeContextRecovery: true,
      },
    });

    expect(result.preparation).toMatchObject({
      sessionId: "cliagent-1",
      generation: 7,
      userEvent: { id: "user-cliagent-1" },
    });
    expect(mocks.publishTurnIntentDispatch).toHaveBeenCalledWith("intent-1", {
      sessionId: "cliagent-1",
      generation: 7,
    });
    expect(mocks.beginOptimisticTurn).toHaveBeenCalledWith(
      "cliagent-1",
      "dispatch"
    );
    expect(mocks.append).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "user-cliagent-1" })],
      "cliagent-1"
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      sessionId: "cliagent-1",
      content: "agent-facing",
      displayText: "visible",
      model: "gpt-5.6-sol",
      accountId: "account-1",
      mode: "build",
      imageDataUrls: ["data:image/png;base64,a"],
      clientMessageId: "direct:1",
      turnIntentId: "intent-1",
      turnIntentSource: "user_submit",
      directUserIntent: true,
      allowNativeContextRecovery: true,
    });
    expect(mocks.confirmTurnRunning).toHaveBeenCalledWith("cliagent-1");
    expect(mocks.updateById).toHaveBeenCalledWith(
      "user-cliagent-1",
      expect.objectContaining({
        displayStatus: "completed",
        result: expect.objectContaining({ deliveryStatus: "sent" }),
      }),
      "cliagent-1"
    );
    expect(mocks.beginOptimisticTurn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.append.mock.invocationCallOrder[0]
    );
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendMessage.mock.invocationCallOrder[0]
    );
  });

  it("keeps the exact synthetic row failed when send fails", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("send failed"));

    await expect(
      dispatchUserIntent({
        sessionId: "agentsession-1",
        visibleText: "hello",
        runtimeStatusSource: "launch",
        send: {
          content: "hello",
          turnIntentId: "intent-failed",
          turnIntentSource: "user_submit",
          directUserIntent: true,
        },
      })
    ).rejects.toThrow("send failed");

    expect(mocks.failOptimisticTurn).toHaveBeenCalledWith(
      "agentsession-1",
      "launch"
    );
    expect(mocks.markTurnTerminal).toHaveBeenCalledWith(
      "agentsession-1",
      "failed",
      { generation: 7 }
    );
    expect(mocks.updateById).toHaveBeenCalledWith(
      "user-agentsession-1",
      expect.objectContaining({
        displayStatus: "failed",
        result: expect.objectContaining({
          deliveryStatus: "failed",
          deliveryError: "send failed",
        }),
      }),
      "agentsession-1"
    );
  });

  it("diagnoses a missing accepted-row projection without resending transport", async () => {
    mocks.updateById.mockResolvedValueOnce(false);

    await expect(
      dispatchUserIntent({
        sessionId: "cliagent-projection-missing",
        visibleText: "hello",
        send: {
          content: "hello",
          turnIntentId: "intent-projection-missing",
          turnIntentSource: "user_submit",
          directUserIntent: true,
        },
      })
    ).resolves.toMatchObject({
      userEvent: {
        result: expect.objectContaining({ deliveryStatus: "sent" }),
      },
    });

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      "Failed to project sent delivery for cliagent-projection-missing",
      expect.objectContaining({
        message: expect.stringContaining("optimistic user event"),
      })
    );
  });

  it("diagnoses a rejected failed-row projection without retrying transport", async () => {
    const transportError = new Error("send failed once");
    const projectionError = new Error("event store unavailable");
    mocks.sendMessage.mockRejectedValueOnce(transportError);
    mocks.updateById.mockRejectedValueOnce(projectionError);

    await expect(
      dispatchUserIntent({
        sessionId: "cliagent-projection-rejected",
        visibleText: "hello",
        send: {
          content: "hello",
          turnIntentId: "intent-projection-rejected",
          turnIntentSource: "user_submit",
          directUserIntent: true,
        },
      })
    ).rejects.toThrow("send failed once");

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      "Failed to project failed delivery for cliagent-projection-rejected",
      projectionError
    );
  });

  it("prepares once, reuses the same row/generation, and supports early working state", async () => {
    mocks.atomValues.set(sessionIdAtom, "cliagent-1");
    const preparation = await prepareUserIntent({
      sessionId: "cliagent-1",
      visibleText: "hello",
      turnIntentId: "intent-prepared",
      runtimeStatusSource: "launch",
    });

    confirmUserIntentPreparation(preparation);
    const result = await dispatchUserIntent({
      sessionId: "cliagent-1",
      visibleText: "hello",
      preparation,
      send: {
        content: "hello",
        turnIntentId: "intent-prepared",
        turnIntentSource: "user_submit",
        directUserIntent: true,
      },
    });

    expect(result.preparation).toBe(preparation);
    expect(mocks.beginTurnDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.createSyntheticUserEvent).toHaveBeenCalledTimes(1);
    // Adoption is idempotently re-appended after transcript synchronization.
    expect(mocks.append).toHaveBeenCalledTimes(2);
    expect(mocks.confirmTurnRunning).toHaveBeenCalledTimes(2);
  });

  it("rejects a preparation from a different concrete session", async () => {
    const source = await prepareUserIntent({
      sessionId: "cliagent-source",
      visibleText: "hello",
      turnIntentId: "intent-transfer",
      runtimeStatusSource: "launch",
    });
    await expect(
      dispatchUserIntent({
        sessionId: "cliagent-target",
        visibleText: "hello",
        preparation: source,
        send: {
          content: "hello",
          turnIntentId: "intent-transfer",
          turnIntentSource: "user_submit",
          directUserIntent: true,
        },
      })
    ).rejects.toThrow("prepared user intent does not match this dispatch");

    expect(mocks.markTurnTerminal).toHaveBeenCalledWith(
      "cliagent-source",
      "failed",
      { generation: 7 }
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
