import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTurnIntentDispatch,
  publishTurnIntentDispatch,
  resetTurnIntentDispatchLifecycleForTests,
} from "../turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  beginTurnStopping,
  clearTurnLifecycleSession,
  confirmTurnRunning,
  forceTurnIdle,
  getLastTurnTerminal,
  getTurnGeneration,
  getTurnPhase,
  getTurnTerminal,
  isTurnActive,
  markTurnRunning,
  markTurnTerminal,
  resetTurnLifecycleForTests,
} from "../turnLifecycle";

const SESSION = "session-1";
const OTHER_SESSION = "session-2";

describe("turnLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTurnIntentDispatchLifecycleForTests();
    resetTurnLifecycleForTests();
  });

  afterEach(() => {
    resetTurnLifecycleForTests();
    resetTurnIntentDispatchLifecycleForTests();
    vi.useRealTimers();
  });

  it("starts idle with generation 0", () => {
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(isTurnActive(SESSION)).toBe(false);
    expect(getTurnGeneration(SESSION)).toBe(0);
    expect(getLastTurnTerminal(SESSION)).toBeNull();
  });

  it("clears recovered intent aliases even before lifecycle state exists", () => {
    publishTurnIntentDispatch("recovered-intent", {
      sessionId: SESSION,
      generation: 7,
    });

    clearTurnLifecycleSession(SESSION);

    expect(getTurnIntentDispatch("recovered-intent")).toBeUndefined();
  });

  it("beginTurnDispatch reserves synchronously and bumps generation", () => {
    const generation = beginTurnDispatch(SESSION);
    expect(generation).toBe(1);
    expect(getTurnPhase(SESSION)).toBe("dispatching");
    expect(isTurnActive(SESSION)).toBe(true);
  });

  it("tracks sessions independently", () => {
    beginTurnDispatch(SESSION);
    expect(getTurnPhase(OTHER_SESSION)).toBe("idle");
  });

  it("full happy path: dispatch → running → terminal → idle", () => {
    const generation = beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    expect(getTurnPhase(SESSION)).toBe("working");
    markTurnTerminal(SESSION, "completed");
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)).toMatchObject({
      generation,
      status: "completed",
    });
  });

  it("markTurnRunning opens a provider-initiated turn from idle", () => {
    markTurnRunning(SESSION);
    expect(getTurnPhase(SESSION)).toBe("working");
    expect(getTurnGeneration(SESSION)).toBe(1);
  });

  it("markTurnRunning does not downgrade stopping", () => {
    beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    beginTurnStopping(SESSION);
    markTurnRunning(SESSION);
    expect(getTurnPhase(SESSION)).toBe("stopping");
  });

  it("confirmTurnRunning promotes dispatching but never opens from idle", () => {
    confirmTurnRunning(SESSION);
    expect(getTurnPhase(SESSION)).toBe("idle");

    beginTurnDispatch(SESSION);
    confirmTurnRunning(SESSION);
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("ignores a confirmation for an older generation", () => {
    const staleGeneration = beginTurnDispatch(SESSION);
    const currentGeneration = beginTurnDispatch(SESSION);

    confirmTurnRunning(SESSION, { generation: staleGeneration });
    expect(getTurnPhase(SESSION)).toBe("dispatching");

    confirmTurnRunning(SESSION, { generation: currentGeneration });
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("beginTurnStopping is a no-op when idle", () => {
    beginTurnStopping(SESSION);
    expect(getTurnPhase(SESSION)).toBe("idle");
  });

  it("stopping resolves to idle on the provider terminal", () => {
    beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    beginTurnStopping(SESSION);
    markTurnTerminal(SESSION, "cancelled");
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)?.status).toBe("cancelled");
  });

  it("keeps a stale exact terminal from changing the newer phase", () => {
    const staleGeneration = beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    markTurnTerminal(SESSION, "completed");

    const currentGeneration = beginTurnDispatch(SESSION);
    expect(currentGeneration).toBe(staleGeneration + 1);
    markTurnRunning(SESSION);

    // Late terminal from the previous turn must not idle the new one.
    markTurnTerminal(SESSION, "completed", { generation: staleGeneration });
    expect(getTurnPhase(SESSION)).toBe("working");

    markTurnTerminal(SESSION, "completed", { generation: currentGeneration });
    expect(getTurnPhase(SESSION)).toBe("idle");
  });

  it("records a delayed first terminal for an older generation", () => {
    const staleGeneration = beginTurnDispatch(SESSION);
    const currentGeneration = beginTurnDispatch(SESSION);

    markTurnTerminal(SESSION, "failed", { generation: staleGeneration });

    expect(getTurnTerminal(SESSION, staleGeneration)).toMatchObject({
      generation: staleGeneration,
      status: "failed",
    });
    expect(getTurnPhase(SESSION)).toBe("dispatching");
    expect(getTurnGeneration(SESSION)).toBe(currentGeneration);
  });

  it("does not move the last-terminal watermark backwards", () => {
    const oldGeneration = beginTurnDispatch(SESSION);
    const currentGeneration = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "completed", { generation: currentGeneration });

    markTurnTerminal(SESSION, "failed", { generation: oldGeneration });

    expect(getTurnTerminal(SESSION, oldGeneration)?.status).toBe("failed");
    expect(getLastTurnTerminal(SESSION)).toMatchObject({
      generation: currentGeneration,
      status: "completed",
    });
  });

  it("retains exact terminals by generation when later turns finish", () => {
    const firstGeneration = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "completed", { generation: firstGeneration });
    const secondGeneration = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "cancelled", { generation: secondGeneration });

    expect(getTurnTerminal(SESSION, firstGeneration)?.status).toBe("completed");
    expect(getTurnTerminal(SESSION, secondGeneration)?.status).toBe(
      "cancelled"
    );
  });

  it("keeps the first terminal final for one exact generation", () => {
    const generation = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "completed", { generation });
    markTurnTerminal(SESSION, "failed", { generation });

    expect(getTurnTerminal(SESSION, generation)?.status).toBe("completed");
    expect(getLastTurnTerminal(SESSION)?.status).toBe("completed");
  });

  it("does not reopen a terminal generation from a late exact running signal", () => {
    const generation = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "failed", { generation });

    markTurnRunning(SESSION, { generation });

    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getTurnGeneration(SESSION)).toBe(generation);
  });

  it("discards an unattributed terminal while dispatching", () => {
    beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "completed");
    expect(getTurnPhase(SESSION)).toBe("dispatching");
  });

  it("accepts a generation-matched terminal while dispatching (dispatch failure path)", () => {
    const generation = beginTurnDispatch(SESSION);
    markTurnTerminal(SESSION, "failed", { generation });
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)?.status).toBe("failed");
  });

  it("accepts an unattributed terminal while working (normal provider turn end)", () => {
    markTurnRunning(SESSION);
    markTurnTerminal(SESSION, "completed");
    expect(getTurnPhase(SESSION)).toBe("idle");
  });

  it("records terminals received while already idle without changing phase", () => {
    markTurnTerminal(SESSION, "completed");
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getLastTurnTerminal(SESSION)?.status).toBe("completed");
  });

  it("forceTurnIdle unlocks immediately and fences in-flight terminals", () => {
    beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    const overriddenGeneration = getTurnGeneration(SESSION);

    forceTurnIdle(SESSION);
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getTurnGeneration(SESSION)).toBe(overriddenGeneration + 1);

    // The overridden turn's late exact terminal remains queryable, but cannot
    // mutate the fenced idle generation.
    markTurnTerminal(SESSION, "cancelled", {
      generation: overriddenGeneration,
    });
    expect(getTurnTerminal(SESSION, overriddenGeneration)?.status).toBe(
      "cancelled"
    );
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getTurnGeneration(SESSION)).toBe(overriddenGeneration + 1);
  });

  it("dead-man: a dispatch that never gets a running ack records failed and fences it", () => {
    const generation = beginTurnDispatch(SESSION);
    vi.advanceTimersByTime(60_000);
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getTurnTerminal(SESSION, generation)?.status).toBe("failed");
    expect(getTurnGeneration(SESSION)).toBe(generation + 1);
  });

  it("dead-man: a stop that never gets a terminal records cancelled and fences it", () => {
    markTurnRunning(SESSION);
    const generation = getTurnGeneration(SESSION);
    beginTurnStopping(SESSION);
    vi.advanceTimersByTime(10_000);
    expect(getTurnPhase(SESSION)).toBe("idle");
    expect(getTurnTerminal(SESSION, generation)?.status).toBe("cancelled");
    expect(getTurnGeneration(SESSION)).toBe(generation + 1);
  });

  it("dead-man does not fire after the phase already resolved", () => {
    beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    markTurnTerminal(SESSION, "completed");
    const generationAfterTerminal = getTurnGeneration(SESSION);
    vi.advanceTimersByTime(120_000);
    expect(getTurnPhase(SESSION)).toBe("idle");
    // forceTurnIdle would have bumped the generation — verify it did not run.
    expect(getTurnGeneration(SESSION)).toBe(generationAfterTerminal);
  });

  it("working is unbounded — no dead-man while the provider owns the turn", () => {
    beginTurnDispatch(SESSION);
    markTurnRunning(SESSION);
    vi.advanceTimersByTime(600_000);
    expect(getTurnPhase(SESSION)).toBe("working");
  });

  it("re-reserving while dispatching restarts the dispatch bound", () => {
    beginTurnDispatch(SESSION);
    vi.advanceTimersByTime(45_000);
    beginTurnDispatch(SESSION);
    vi.advanceTimersByTime(45_000);
    expect(getTurnPhase(SESSION)).toBe("dispatching");
    vi.advanceTimersByTime(15_000);
    expect(getTurnPhase(SESSION)).toBe("idle");
  });
});
