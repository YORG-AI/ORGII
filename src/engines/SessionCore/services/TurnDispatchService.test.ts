import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearRecentOptimisticTurn } from "@src/engines/SessionCore/control/optimisticTurnStatus";
import {
  getTurnIntentDispatch,
  publishTurnIntentDispatch,
  resetTurnIntentDispatchLifecycleForTests,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  getLastTurnTerminal,
  getTurnPhase,
  getTurnTerminal,
  markTurnTerminal,
  resetTurnLifecycleForTests,
} from "@src/engines/SessionCore/control/turnLifecycle";
import {
  sessionRuntimeStatusAtom,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  dispatchTurn,
  failReservedTurn,
  reserveTurnDispatch,
  resetTurnDispatchMonitorsForTests,
  sendReservedTurn,
  waitForTurnOutcome,
} from "./TurnDispatchService";

createInstrumentedStore();

const mocks = vi.hoisted(() => ({
  getTurnIntentStatus: vi.fn(),
  markSessionActive: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@src/store/session", () => ({
  markSessionActive: mocks.markSessionActive,
}));

vi.mock("./SessionService", () => ({
  SessionService: {
    getTurnIntentStatus: mocks.getTurnIntentStatus,
    sendMessage: mocks.sendMessage,
  },
}));

const SESSION = "sdeagent-session-1";

describe("TurnDispatchService", () => {
  beforeEach(() => {
    resetTurnDispatchMonitorsForTests();
    resetTurnIntentDispatchLifecycleForTests();
    resetTurnLifecycleForTests();
    mocks.markSessionActive.mockReset();
    mocks.getTurnIntentStatus.mockReset().mockResolvedValue(null);
    mocks.sendMessage.mockReset().mockResolvedValue({ duplicate: false });
    getInstrumentedStore().set(setSessionRuntimeStatusAtom, {
      sessionId: SESSION,
      status: "idle",
      source: "dispatch",
    });
  });

  afterEach(() => {
    resetTurnDispatchMonitorsForTests();
    clearRecentOptimisticTurn(SESSION);
    clearRecentOptimisticTurn("cursoride-session-1");
    resetTurnLifecycleForTests();
  });

  it("reserves the generation and publishes the intent synchronously", () => {
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-1",
    });

    expect(dispatch).toMatchObject({
      sessionId: SESSION,
      turnIntentId: "intent-1",
      generation: 1,
    });
    expect(getTurnPhase(SESSION)).toBe("dispatching");
    expect(getTurnIntentDispatch("intent-1")).toEqual({
      sessionId: SESSION,
      generation: 1,
    });
  });

  it("sends the reserved identity and confirms running after acceptance", async () => {
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-2",
    });

    await expect(
      sendReservedTurn({
        dispatch,
        content: "hello",
        turnIntentSource: "user_submit",
      })
    ).resolves.toMatchObject({ accepted: true, turnIntentId: "intent-2" });
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        content: "hello",
        turnIntentId: "intent-2",
        clientMessageId: "intent-2",
      })
    );
    expect(mocks.markSessionActive).toHaveBeenCalledWith(SESSION);
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("reserves and forwards headless dispatch options through one call", async () => {
    const accepted = await dispatchTurn({
      sessionId: SESSION,
      content: "execute plan",
      workspacePath: "/workspace/repo-a",
      turnIntentSource: "user_submit",
    });

    expect(accepted).toMatchObject({
      accepted: true,
      sessionId: SESSION,
      generation: 1,
    });
    expect(accepted.turnIntentId).toEqual(expect.any(String));
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        content: "execute plan",
        workspacePath: "/workspace/repo-a",
        turnIntentId: accepted.turnIntentId,
      })
    );
    expect(getTurnIntentDispatch(accepted.turnIntentId)).toEqual({
      sessionId: SESSION,
      generation: accepted.generation,
    });
  });

  it("closes the exact reservation when transport rejects", async () => {
    mocks.sendMessage.mockRejectedValueOnce(new Error("transport down"));
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-3",
    });

    await expect(
      sendReservedTurn({
        dispatch,
        content: "hello",
        turnIntentSource: "user_submit",
      })
    ).rejects.toThrow("transport down");
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)).toMatchObject({
      generation: dispatch.generation,
      status: "failed",
    });
  });

  it("does not reopen a fast terminal that arrives before send resolves", async () => {
    let resolveSend!: (receipt: { duplicate: boolean }) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<{ duplicate: boolean }>((resolve) => {
        resolveSend = resolve;
      })
    );
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-fast",
    });
    const accepted = sendReservedTurn({
      dispatch,
      content: "hello",
      turnIntentSource: "user_submit",
    });

    markTurnTerminal(SESSION, "completed", {
      generation: dispatch.generation,
    });
    resolveSend({ duplicate: false });
    await accepted;

    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)).toMatchObject({
      generation: dispatch.generation,
      status: "completed",
    });
  });

  it("does not let an old send acknowledgement promote a newer generation", async () => {
    let resolveFirst!: (receipt: { duplicate: boolean }) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<{ duplicate: boolean }>((resolve) => {
        resolveFirst = resolve;
      })
    );
    const first = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-old-ack",
    });
    const firstSend = sendReservedTurn({
      dispatch: first,
      content: "first",
      turnIntentSource: "user_submit",
    });
    const second = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-current",
    });

    resolveFirst({ duplicate: false });
    await firstSend;

    expect(second.generation).toBe(first.generation + 1);
    expect(getTurnPhase(SESSION)).toBe("dispatching");
  });

  it("does not let an old terminal receipt clear a newer optimistic mirror", async () => {
    let resolveFirst!: (receipt: { duplicate: boolean }) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<{ duplicate: boolean }>((resolve) => {
        resolveFirst = resolve;
      })
    );
    mocks.getTurnIntentStatus.mockResolvedValueOnce({
      status: "completed",
      effectiveTurnIntentId: "intent-old-terminal-receipt",
    });
    const first = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-old-terminal-receipt",
    });
    const firstSend = sendReservedTurn({
      dispatch: first,
      content: "first",
      turnIntentSource: "user_submit",
    });
    const firstOutcome = waitForTurnOutcome(first, Date.now() + 1_000);
    const newer = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-newer-optimistic",
    });
    await sendReservedTurn({
      dispatch: newer,
      content: "newer",
      turnIntentSource: "user_submit",
    });

    resolveFirst({ duplicate: true });
    await firstSend;
    await expect(firstOutcome).resolves.toMatchObject({ status: "completed" });

    expect(getTurnPhase(SESSION)).toBe("working");
    expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
      "running"
    );
  });

  it("records a delayed older pre-transport failure while a newer turn stays working", async () => {
    const older = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-old-pretransport-failure",
    });
    const olderOutcome = waitForTurnOutcome(older, Date.now() + 1_000);
    const newer = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-newer-working",
    });
    await sendReservedTurn({
      dispatch: newer,
      content: "newer",
      turnIntentSource: "user_submit",
    });

    failReservedTurn(older);

    await expect(olderOutcome).resolves.toMatchObject({ status: "failed" });
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("does not let an old rejected send roll back a newer optimistic mirror", async () => {
    let rejectFirst!: (error: Error) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<{ duplicate: boolean }>((_resolve, reject) => {
        rejectFirst = reject;
      })
    );
    const first = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-old-rejection",
    });
    const firstSend = sendReservedTurn({
      dispatch: first,
      content: "first",
      turnIntentSource: "user_submit",
    });
    reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-newer-after-rejection",
    });

    rejectFirst(new Error("old IPC rejection"));
    await expect(firstSend).rejects.toThrow("old IPC rejection");

    expect(getTurnPhase(SESSION)).toBe("dispatching");
    expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
      "running"
    );
  });

  it("does not overwrite a fast exact terminal when the send response is lost", async () => {
    let rejectSend!: (error: Error) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject;
      })
    );
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-response-lost",
    });
    const sent = sendReservedTurn({
      dispatch,
      content: "hello",
      turnIntentSource: "user_submit",
    });

    markTurnTerminal(SESSION, "completed", {
      generation: dispatch.generation,
    });
    rejectSend(new Error("IPC response lost"));
    await expect(sent).rejects.toThrow("IPC response lost");

    expect(getLastTurnTerminal(SESSION)).toMatchObject({
      generation: dispatch.generation,
      status: "completed",
    });
  });

  it.each(["queued", "running"])(
    "settles a response-loss steering intent after durable %s becomes completed",
    async (receiptStatus) => {
      vi.useFakeTimers();
      try {
        const turnIntentId = `intent-${receiptStatus}-steering-response-loss`;
        mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
        mocks.getTurnIntentStatus
          .mockResolvedValueOnce({
            status: receiptStatus,
            effectiveTurnIntentId: turnIntentId,
          })
          .mockResolvedValueOnce({
            status: "completed",
            effectiveTurnIntentId: turnIntentId,
          });
        const dispatch = reserveTurnDispatch({
          sessionId: SESSION,
          turnIntentId,
        });

        await expect(
          sendReservedTurn({
            dispatch,
            content: "steer existing turn",
            turnIntentSource: "user_submit",
          })
        ).resolves.toMatchObject({
          accepted: true,
          turnIntentId,
        });
        const outcome = waitForTurnOutcome(dispatch, Date.now() + 1_000);
        expect(getTurnPhase(SESSION)).toBe("working");
        // One monitor timer plus waitForTurnOutcome's deadline.
        expect(vi.getTimerCount()).toBe(2);

        await vi.advanceTimersByTimeAsync(100);

        await expect(outcome).resolves.toMatchObject({ status: "completed" });
        expect(getTurnPhase(SESSION)).toBe("idle");
        expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
          "running"
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        resetTurnDispatchMonitorsForTests();
        vi.useRealTimers();
      }
    }
  );

  it.each(["queued", "running"])(
    "settles a duplicate steering receipt after durable %s becomes completed",
    async (receiptStatus) => {
      vi.useFakeTimers();
      try {
        const turnIntentId = `intent-${receiptStatus}-steering-duplicate`;
        mocks.sendMessage.mockResolvedValueOnce({
          duplicate: true,
          turnIntentStatus: receiptStatus,
          effectiveTurnIntentId: turnIntentId,
        });
        mocks.getTurnIntentStatus.mockResolvedValueOnce({
          status: "completed",
          effectiveTurnIntentId: turnIntentId,
        });
        const dispatch = reserveTurnDispatch({
          sessionId: SESSION,
          turnIntentId,
        });

        await sendReservedTurn({
          dispatch,
          content: "duplicate steering retry",
          turnIntentSource: "user_submit",
        });
        const outcome = waitForTurnOutcome(dispatch, Date.now() + 1_000);
        expect(mocks.getTurnIntentStatus).not.toHaveBeenCalled();
        // One monitor timer plus waitForTurnOutcome's deadline.
        expect(vi.getTimerCount()).toBe(2);

        await vi.advanceTimersByTimeAsync(100);

        await expect(outcome).resolves.toMatchObject({ status: "completed" });
        expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
          "running"
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        resetTurnDispatchMonitorsForTests();
        vi.useRealTimers();
      }
    }
  );

  it("does not poll an ordinary exact acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMessage.mockResolvedValueOnce({
        duplicate: false,
        turnIntentStatus: "running",
        effectiveTurnIntentId: "intent-ordinary-ack",
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-ordinary-ack",
      });

      await sendReservedTurn({
        dispatch,
        content: "ordinary turn",
        turnIntentSource: "user_submit",
      });

      expect(mocks.getTurnIntentStatus).not.toHaveBeenCalled();
      expect(getTurnPhase(SESSION)).toBe("working");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("stops an ambiguous exact-X monitor on a live terminal", async () => {
    vi.useFakeTimers();
    try {
      const turnIntentId = "intent-ambiguous-live-terminal";
      mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
      mocks.getTurnIntentStatus.mockResolvedValue({
        status: "running",
        effectiveTurnIntentId: turnIntentId,
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId,
      });

      await sendReservedTurn({
        dispatch,
        content: "ambiguous turn",
        turnIntentSource: "user_submit",
      });
      const callsBeforeTerminal = mocks.getTurnIntentStatus.mock.calls.length;
      expect(vi.getTimerCount()).toBe(1);

      markTurnTerminal(SESSION, "completed", {
        generation: dispatch.generation,
      });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.getTurnIntentStatus).toHaveBeenCalledTimes(
        callsBeforeTerminal
      );
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("stops an ambiguous exact-X monitor when its generation is superseded", async () => {
    vi.useFakeTimers();
    try {
      const turnIntentId = "intent-ambiguous-superseded";
      mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
      mocks.getTurnIntentStatus.mockResolvedValue({
        status: "queued",
        effectiveTurnIntentId: turnIntentId,
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId,
      });

      await sendReservedTurn({
        dispatch,
        content: "ambiguous turn",
        turnIntentSource: "user_submit",
      });
      const callsBeforeSupersession =
        mocks.getTurnIntentStatus.mock.calls.length;
      expect(vi.getTimerCount()).toBe(1);

      const newer = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-after-ambiguous",
      });
      expect(newer.generation).toBe(dispatch.generation + 1);
      // Only the newer dispatch dead-man remains; the old status monitor was
      // cancelled synchronously by generation supersession.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.getTurnIntentStatus).toHaveBeenCalledTimes(
        callsBeforeSupersession
      );
      failReservedTurn(newer);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "projects a durable %s receipt onto the exact terminal",
    async (receiptStatus, expectedTerminal) => {
      mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
      mocks.getTurnIntentStatus.mockResolvedValueOnce({
        status: receiptStatus,
        effectiveTurnIntentId: `intent-${receiptStatus}-receipt`,
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: `intent-${receiptStatus}-receipt`,
      });

      await sendReservedTurn({
        dispatch,
        content: "hello",
        turnIntentSource: "user_submit",
      });

      await expect(
        waitForTurnOutcome(dispatch, Date.now() + 1_000)
      ).resolves.toMatchObject({ status: expectedTerminal });
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        expectedTerminal
      );
    }
  );

  it("reconciles a successful duplicate acknowledgement instead of assuming a terminal will arrive", async () => {
    mocks.sendMessage.mockResolvedValueOnce({ duplicate: true });
    mocks.getTurnIntentStatus.mockResolvedValueOnce({
      status: "coalesced",
      effectiveTurnIntentId: "intent-coalesced-receipt",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-coalesced-receipt",
    });

    await expect(
      sendReservedTurn({
        dispatch,
        content: "hello",
        turnIntentSource: "user_submit",
      })
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "failed" });
    expect(mocks.getTurnIntentStatus).toHaveBeenCalledWith(
      SESSION,
      "intent-coalesced-receipt"
    );
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe("failed");
  });

  it("prefers an exact status carried by the duplicate acknowledgement", async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      duplicate: true,
      turnIntentStatus: "completed",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-acknowledged-terminal",
    });

    await sendReservedTurn({
      dispatch,
      content: "hello",
      turnIntentSource: "user_submit",
    });

    expect(mocks.getTurnIntentStatus).not.toHaveBeenCalled();
    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("settles a steered augmentation immediately without projecting the provider idle", async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      duplicate: false,
      steered: true,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "intent-steered",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-steered",
    });

    await sendReservedTurn({
      dispatch,
      content: "adjust course",
      turnIntentSource: "user_submit",
    });

    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "completed" });
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
      "running"
    );
    expect(mocks.getTurnIntentStatus).not.toHaveBeenCalled();
  });

  it("aliases a normal Project acknowledgement before reconciling its effective run", async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      duplicate: false,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "wir_effective-normal",
    });
    mocks.getTurnIntentStatus.mockResolvedValueOnce({
      status: "running",
      effectiveTurnIntentId: "wir_effective-normal",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-project-normal",
    });

    await sendReservedTurn({
      dispatch,
      content: "project task",
      turnIntentSource: "user_submit",
    });

    expect(getTurnIntentDispatch("wir_effective-normal")).toEqual({
      sessionId: SESSION,
      generation: dispatch.generation,
    });
    expect(mocks.getTurnIntentStatus).toHaveBeenCalledWith(
      SESSION,
      "intent-project-normal"
    );
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("polls durable Project ownership and records failure before runtime starts", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMessage.mockResolvedValueOnce({
        duplicate: false,
        turnIntentStatus: "queued",
        effectiveTurnIntentId: "wir_dead-letter-before-runtime",
      });
      mocks.getTurnIntentStatus
        .mockResolvedValueOnce({
          status: "queued",
          effectiveTurnIntentId: "wir_dead-letter-before-runtime",
        })
        .mockResolvedValueOnce({
          status: "failed",
          effectiveTurnIntentId: "wir_dead-letter-before-runtime",
        });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-dead-letter-before-runtime",
      });

      await sendReservedTurn({
        dispatch,
        content: "project task",
        turnIntentSource: "user_submit",
      });
      const outcome = waitForTurnOutcome(dispatch, Date.now() + 1_000);
      expect(getTurnPhase(SESSION)).toBe("working");

      await vi.advanceTimersByTimeAsync(100);

      await expect(outcome).resolves.toMatchObject({ status: "failed" });
      expect(getTurnPhase(SESSION)).toBe("idle");
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "failed"
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("does not synthesize failure after more than the 20-minute claim horizon", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMessage.mockResolvedValueOnce({
        duplicate: false,
        turnIntentStatus: "queued",
        effectiveTurnIntentId: "wir_stuck-queued",
      });
      mocks.getTurnIntentStatus.mockResolvedValue({
        status: "queued",
        effectiveTurnIntentId: "wir_stuck-queued",
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-stuck-queued",
      });

      await sendReservedTurn({
        dispatch,
        content: "project task",
        turnIntentSource: "user_submit",
      });
      const outcome = waitForTurnOutcome(dispatch, Date.now() + 22 * 60_000);
      expect(getTurnPhase(SESSION)).toBe("working");

      await vi.advanceTimersByTimeAsync(20 * 60_000 + 1);

      expect(getTurnPhase(SESSION)).toBe("working");
      expect(getTurnTerminal(SESSION, dispatch.generation)).toBeNull();
      expect(mocks.getTurnIntentStatus.mock.calls.length).toBeLessThanOrEqual(
        50
      );
      mocks.getTurnIntentStatus.mockResolvedValue({
        status: "failed",
        effectiveTurnIntentId: "wir_stuck-queued",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(outcome).resolves.toMatchObject({ status: "failed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("cancels the Project safety poll and lifecycle subscription on reset", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMessage.mockResolvedValueOnce({
        duplicate: false,
        turnIntentStatus: "queued",
        effectiveTurnIntentId: "wir_reset-monitor",
      });
      mocks.getTurnIntentStatus.mockResolvedValue({
        status: "queued",
        effectiveTurnIntentId: "wir_reset-monitor",
      });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-reset-monitor",
      });

      await sendReservedTurn({
        dispatch,
        content: "project task",
        turnIntentSource: "user_submit",
      });
      const callsBeforeReset = mocks.getTurnIntentStatus.mock.calls.length;
      expect(vi.getTimerCount()).toBe(1);

      resetTurnDispatchMonitorsForTests();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(mocks.getTurnIntentStatus).toHaveBeenCalledTimes(callsBeforeReset);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("recovers a Project terminal that happened before its acknowledgement alias arrived", async () => {
    let resolveSend!: (receipt: {
      duplicate: boolean;
      turnIntentStatus: string;
      effectiveTurnIntentId: string;
    }) => void;
    mocks.sendMessage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSend = resolve;
      })
    );
    mocks.getTurnIntentStatus.mockResolvedValueOnce({
      status: "completed",
      effectiveTurnIntentId: "wir_finished-before-ack",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-before-alias",
    });
    const sent = sendReservedTurn({
      dispatch,
      content: "fast project task",
      turnIntentSource: "user_submit",
    });

    expect(getTurnIntentDispatch("wir_finished-before-ack")).toBeUndefined();
    resolveSend({
      duplicate: false,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "wir_finished-before-ack",
    });
    await sent;

    expect(getTurnIntentDispatch("wir_finished-before-ack")).toEqual({
      sessionId: SESSION,
      generation: dispatch.generation,
    });
    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("installs the effective alias from an ambiguous response-loss lookup", async () => {
    vi.useFakeTimers();
    try {
      mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
      mocks.getTurnIntentStatus
        .mockResolvedValueOnce({
          status: "running",
          effectiveTurnIntentId: "wir_response-loss",
        })
        .mockResolvedValueOnce({
          status: "completed",
          effectiveTurnIntentId: "wir_response-loss",
        });
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: "intent-response-loss-project",
      });

      await sendReservedTurn({
        dispatch,
        content: "project task",
        turnIntentSource: "user_submit",
      });

      expect(getTurnIntentDispatch("wir_response-loss")).toEqual({
        sessionId: SESSION,
        generation: dispatch.generation,
      });
      expect(getTurnPhase(SESSION)).toBe("working");
      const outcome = waitForTurnOutcome(dispatch, Date.now() + 1_000);

      await vi.advanceTimersByTimeAsync(100);

      await expect(outcome).resolves.toMatchObject({ status: "completed" });
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "completed"
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      resetTurnDispatchMonitorsForTests();
      vi.useRealTimers();
    }
  });

  it("reconciles a duplicate effective run against the original generation", async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      duplicate: true,
      turnIntentStatus: "completed",
      effectiveTurnIntentId: "wir_duplicate-effective",
    });
    mocks.getTurnIntentStatus.mockResolvedValueOnce({
      status: "completed",
      effectiveTurnIntentId: "wir_duplicate-effective",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-project-duplicate",
    });

    await sendReservedTurn({
      dispatch,
      content: "retry project task",
      turnIntentSource: "user_submit",
    });

    expect(getTurnIntentDispatch("wir_duplicate-effective")).toEqual({
      sessionId: SESSION,
      generation: dispatch.generation,
    });
    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("fails closed without overwriting a conflicting effective alias", async () => {
    publishTurnIntentDispatch("wir_conflicting", {
      sessionId: "sdeagent-other",
      generation: 9,
    });
    mocks.sendMessage.mockResolvedValueOnce({
      duplicate: false,
      turnIntentStatus: "queued",
      effectiveTurnIntentId: "wir_conflicting",
    });
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-alias-conflict",
    });

    await expect(
      sendReservedTurn({
        dispatch,
        content: "project task",
        turnIntentSource: "user_submit",
      })
    ).rejects.toThrow(/conflicts/);

    expect(getTurnIntentDispatch("wir_conflicting")).toEqual({
      sessionId: "sdeagent-other",
      generation: 9,
    });
    await expect(
      waitForTurnOutcome(dispatch, Date.now() + 1_000)
    ).resolves.toMatchObject({ status: "failed" });
  });

  it.each(["optimistic", "stale", "rejected", "future_status", null])(
    "fails closed for a non-executable durable receipt %s",
    async (receiptStatus) => {
      mocks.sendMessage.mockRejectedValueOnce(new Error("IPC response lost"));
      mocks.getTurnIntentStatus.mockResolvedValueOnce(
        receiptStatus === null
          ? null
          : {
              status: receiptStatus,
              effectiveTurnIntentId: `intent-non-executable-${String(receiptStatus)}`,
            }
      );
      const dispatch = reserveTurnDispatch({
        sessionId: SESSION,
        turnIntentId: `intent-non-executable-${String(receiptStatus)}`,
      });

      await expect(
        sendReservedTurn({
          dispatch,
          content: "hello",
          turnIntentSource: "user_submit",
        })
      ).rejects.toThrow("IPC response lost");
      expect(getTurnPhase(SESSION)).toBe("idle");
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe("idle");
    }
  );

  it("settles Cursor handoffs immediately because they have no terminal stream", async () => {
    const dispatch = reserveTurnDispatch({
      sessionId: "cursoride-session-1",
      turnIntentId: "intent-cursor",
    });

    await sendReservedTurn({
      dispatch,
      content: "hello",
      turnIntentSource: "user_submit",
    });
    expect(getLastTurnTerminal("cursoride-session-1")).toMatchObject({
      generation: dispatch.generation,
      status: "completed",
    });
  });

  it("waits for and returns the exact generation terminal", async () => {
    const dispatch = reserveTurnDispatch({
      sessionId: SESSION,
      turnIntentId: "intent-4",
    });
    const outcomePromise = waitForTurnOutcome(dispatch, Date.now() + 1_000);

    markTurnTerminal(SESSION, "cancelled", {
      generation: dispatch.generation,
    });

    await expect(outcomePromise).resolves.toMatchObject({
      turnIntentId: "intent-4",
      generation: dispatch.generation,
      status: "cancelled",
    });
  });
});
