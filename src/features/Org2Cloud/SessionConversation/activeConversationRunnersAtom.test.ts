import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  collectLandedTurnIds,
  conversationRunnerRegistryKey,
  overlayableRunnerEvents,
  selectActiveRunners,
} from "./activeConversationRunnersAtom";

describe("conversationRunnerRegistryKey", () => {
  it("isolates the same root id in different organizations", () => {
    expect(conversationRunnerRegistryKey("org-a", "root")).not.toBe(
      conversationRunnerRegistryKey("org-b", "root")
    );
  });
});

const row = (turnId: string, source: "user" | "assistant" | "system") => ({
  turnId,
  event: { source },
});

describe("collectLandedTurnIds", () => {
  it("ignores the user row pushed ahead of the runner", () => {
    expect(collectLandedTurnIds([row("t1", "user")])).toEqual(new Set());
  });

  it("marks a turn landed once any agent row is on the plane", () => {
    expect(
      collectLandedTurnIds([
        row("t1", "user"),
        row("t2", "user"),
        row("t1", "assistant"),
      ])
    ).toEqual(new Set(["t1"]));
    expect(collectLandedTurnIds([row("t3", "system")])).toEqual(
      new Set(["t3"])
    );
  });
});

describe("selectActiveRunners", () => {
  const runners = [
    { runnerSessionId: "r1", turnId: "t1", turnIntentId: "i1" },
    { runnerSessionId: "r2", turnId: "t2", turnIntentId: "i2" },
  ];

  it("keeps a runner while only its user row is on the plane", () => {
    const landed = collectLandedTurnIds([row("t1", "user"), row("t2", "user")]);
    expect(selectActiveRunners(runners, landed)).toEqual(runners);
  });

  it("drops a runner once its agent tail landed", () => {
    const landed = collectLandedTurnIds([
      row("t1", "user"),
      row("t1", "assistant"),
      row("t2", "user"),
    ]);
    expect(selectActiveRunners(runners, landed)).toEqual([runners[1]]);
  });
});

describe("overlayableRunnerEvents", () => {
  const event = (overrides: Partial<SessionEvent>) =>
    ({
      id: "event",
      source: "assistant",
      result: {},
      ...overrides,
    }) as SessionEvent;
  const user = (id: string, turnIntentId: string) =>
    event({
      id,
      source: "user",
      result: { turnIntentId },
    });

  it("overlays only the current turn from a reused runner", () => {
    const events = [
      user("old-user", "old-intent"),
      event({ id: "old-tail" }),
      user("current-user", "current-intent"),
      event({ id: "current-tail" }),
    ];
    expect(
      overlayableRunnerEvents(events, "current-intent").map((item) => item.id)
    ).toEqual(["current-tail"]);
  });
});
