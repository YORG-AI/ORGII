import { beforeEach, describe, expect, it } from "vitest";

import {
  getTurnIntentDispatch,
  publishTurnIntentDispatch,
  publishTurnIntentDispatchAlias,
  resetTurnIntentDispatchLifecycleForTests,
  retireSessionTurnIntentDispatches,
  retireTurnIntentDispatch,
} from "../turnIntentDispatchLifecycle";

describe("turnIntentDispatchLifecycle", () => {
  beforeEach(() => resetTurnIntentDispatchLifecycleForTests());

  it("never evicts a live long-running identity under recent-turn churn", () => {
    publishTurnIntentDispatch("long-running", {
      sessionId: "long-session",
      generation: 1,
    });

    for (let index = 0; index < 250; index += 1) {
      const sessionId = `short-session-${index}`;
      publishTurnIntentDispatch(`short-${index}`, {
        sessionId,
        generation: 1,
      });
      retireTurnIntentDispatch(sessionId, 1);
    }

    expect(getTurnIntentDispatch("long-running")).toEqual({
      sessionId: "long-session",
      generation: 1,
    });
  });

  it("retires only the exact generation and keeps it in bounded history", () => {
    publishTurnIntentDispatch("first", {
      sessionId: "session",
      generation: 1,
    });
    publishTurnIntentDispatch("second", {
      sessionId: "session",
      generation: 2,
    });

    retireTurnIntentDispatch("session", 1);

    expect(getTurnIntentDispatch("first")).toEqual({
      sessionId: "session",
      generation: 1,
    });
    expect(getTurnIntentDispatch("second")).toEqual({
      sessionId: "session",
      generation: 2,
    });
  });

  it("removes live identities when their session is deleted", () => {
    publishTurnIntentDispatch("intent", {
      sessionId: "deleted-session",
      generation: 1,
    });

    retireSessionTurnIntentDispatches("deleted-session");

    expect(getTurnIntentDispatch("intent")).toBeUndefined();
  });

  it("binds a backend-selected alias to the exact local generation", () => {
    publishTurnIntentDispatch("composer-intent", {
      sessionId: "session",
      generation: 7,
    });

    expect(
      publishTurnIntentDispatchAlias("wir_effective", {
        sessionId: "session",
        generation: 7,
      })
    ).toBe(true);
    expect(getTurnIntentDispatch("wir_effective")).toEqual({
      sessionId: "session",
      generation: 7,
    });
  });

  it("fails closed instead of overwriting a conflicting alias", () => {
    publishTurnIntentDispatch("wir_conflict", {
      sessionId: "other-session",
      generation: 3,
    });

    expect(
      publishTurnIntentDispatchAlias("wir_conflict", {
        sessionId: "session",
        generation: 7,
      })
    ).toBe(false);
    expect(getTurnIntentDispatch("wir_conflict")).toEqual({
      sessionId: "other-session",
      generation: 3,
    });
  });
});
