import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishTurnIntentDispatch,
  resetTurnIntentDispatchLifecycleForTests,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  getTurnPhase,
  resetTurnLifecycleForTests,
} from "@src/engines/SessionCore/control/turnLifecycle";

import { CliTurnLifecycleCoordinator } from "./cliTurnLifecycleCoordinator";

describe("CliTurnLifecycleCoordinator", () => {
  beforeEach(() => {
    resetTurnLifecycleForTests();
    resetTurnIntentDispatchLifecycleForTests();
  });

  it("binds current terminals to the dispatched generation and drops stale intents", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());
    const sessionId = "cliagent-current";
    const generation = beginTurnDispatch(sessionId);
    publishTurnIntentDispatch("intent-current", { sessionId, generation });

    expect(
      coordinator.handleStatus({
        sessionId,
        status: "running",
        turnIntentId: "intent-current",
      })
    ).toBe(true);
    expect(getTurnPhase(sessionId)).toBe("working");

    expect(
      coordinator.handleStatus({
        sessionId,
        status: "completed",
        turnIntentId: "intent-old",
      })
    ).toBe(false);
    expect(getTurnPhase(sessionId)).toBe("working");

    expect(
      coordinator.handleStatus({
        sessionId,
        status: "completed",
        turnIntentId: "intent-current",
      })
    ).toBe(true);
    expect(getTurnPhase(sessionId)).toBe("idle");
    expect(coordinator.activeSessionCount).toBe(0);
  });

  it("creates and closes a local generation for an unknown cross-window intent", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());
    const sessionId = "cliagent-cross-window";

    coordinator.handleStatus({
      sessionId,
      status: "running",
      turnIntentId: "remote-intent",
    });
    expect(getTurnPhase(sessionId)).toBe("working");

    coordinator.handleStatus({
      sessionId,
      status: "failed",
      turnIntentId: "remote-intent",
    });
    expect(getTurnPhase(sessionId)).toBe("idle");

    expect(
      coordinator.handleStatus({
        sessionId,
        status: "running",
        turnIntentId: "remote-intent",
      })
    ).toBe(false);
    expect(getTurnPhase(sessionId)).toBe("idle");
  });

  it("does not let an unattributed terminal close a tracked intent", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());
    const sessionId = "cliagent-attributed";
    coordinator.handleStatus({
      sessionId,
      status: "running",
      turnIntentId: "intent-attributed",
    });

    expect(coordinator.handleStatus({ sessionId, status: "completed" })).toBe(
      false
    );
    expect(getTurnPhase(sessionId)).toBe("working");

    coordinator.clearSession(sessionId);
    expect(getTurnPhase(sessionId)).toBe("idle");
    expect(coordinator.activeSessionCount).toBe(0);
  });

  it("rejects excess unknown intents without evicting active generations", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());
    for (let index = 0; index < 256; index += 1) {
      expect(
        coordinator.handleStatus({
          sessionId: `cliagent-cap-${index}`,
          status: "running",
          turnIntentId: `intent-cap-${index}`,
        })
      ).toBe(true);
    }

    expect(
      coordinator.handleStatus({
        sessionId: "cliagent-cap-overflow",
        status: "running",
        turnIntentId: "intent-cap-overflow",
      })
    ).toBe(false);
    expect(coordinator.activeSessionCount).toBe(256);

    expect(
      coordinator.handleStatus({
        sessionId: "cliagent-cap-0",
        status: "completed",
        turnIntentId: "intent-cap-0",
      })
    ).toBe(true);
    expect(coordinator.activeSessionCount).toBe(255);
  });

  it("shares one batch request across concurrent reconnect and focus triggers", async () => {
    let resolveBatch!: (value: never[]) => void;
    const loadBatch = vi.fn(
      () =>
        new Promise<never[]>((resolve) => {
          resolveBatch = resolve;
        })
    );
    const coordinator = new CliTurnLifecycleCoordinator(loadBatch);
    coordinator.handleStatus({
      sessionId: "cliagent-reconcile",
      status: "running",
      turnIntentId: "intent-reconcile",
    });

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();

    expect(first).toBe(second);
    expect(loadBatch).toHaveBeenCalledOnce();
    expect(loadBatch).toHaveBeenCalledWith({
      sessionIds: ["cliagent-reconcile"],
    });
    resolveBatch([]);
    await first;
  });

  it("does not reconcile while the document is hidden", async () => {
    const loadBatch = vi.fn(async () => []);
    const coordinator = new CliTurnLifecycleCoordinator(loadBatch);
    coordinator.handleStatus({
      sessionId: "cliagent-hidden",
      status: "running",
      turnIntentId: "intent-hidden",
    });
    const originalDocument = globalThis.document;
    vi.stubGlobal("document", { visibilityState: "hidden" });

    await coordinator.reconcile();

    expect(loadBatch).not.toHaveBeenCalled();
    vi.stubGlobal("document", originalDocument);
  });
});
