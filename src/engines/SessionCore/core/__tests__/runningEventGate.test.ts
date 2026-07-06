import { describe, expect, it } from "vitest";

import {
  classifyLatestTurnActivity,
  hasLiveRuntimeResourceInLatestTurn,
  hasRunningAwaitWaitForInLatestTurn,
  isLiveRuntimeResourceEvent,
  sessionHasComposerStopBlockingWork,
  shellProcessStatusFromArgs,
} from "../runningEventGate";
import type { SessionEvent } from "../types";

function shellEvent(
  shellProcessStatus: "running" | "background" | "exited" | "killed"
): SessionEvent {
  return {
    id: `event-${shellProcessStatus}`,
    sessionId: "session-1",
    source: "assistant",
    createdAt: new Date().toISOString(),
    actionType: "tool_call",
    functionName: "run_shell",
    displayStatus: "completed",
    displayVariant: "tool_call",
    args: {
      command: "sleep 45",
      shellPid: 12345,
      shellProcessStatus,
    },
  } as unknown as SessionEvent;
}

function hiddenStatusEvent(): SessionEvent {
  return {
    id: "hidden-running",
    sessionId: "session-1",
    source: "assistant",
    createdAt: new Date().toISOString(),
    actionType: "raw",
    functionName: "hidden_status",
    displayStatus: "running",
    displayVariant: "session",
    result: { status: "running" },
  } as unknown as SessionEvent;
}

describe("shellProcessStatusFromArgs", () => {
  it("returns undefined for falsy args", () => {
    expect(shellProcessStatusFromArgs(undefined)).toBeUndefined();
    expect(shellProcessStatusFromArgs(null)).toBeUndefined();
    expect(shellProcessStatusFromArgs("")).toBeUndefined();
  });

  it("extracts shellProcessStatus from object args", () => {
    expect(shellProcessStatusFromArgs({ shellProcessStatus: "running" })).toBe(
      "running"
    );
  });

  it("returns undefined without parsing when field name is absent from string args (fast bail)", () => {
    expect(
      shellProcessStatusFromArgs('{"command":"ls","exitCode":0}')
    ).toBeUndefined();
  });

  it("parses string args and returns status when shellProcessStatus field is present", () => {
    expect(
      shellProcessStatusFromArgs('{"shellProcessStatus":"running","pid":42}')
    ).toBe("running");
  });

  it("returns undefined for malformed JSON string that contains the field name", () => {
    expect(
      shellProcessStatusFromArgs('{"shellProcessStatus": broken json')
    ).toBeUndefined();
  });

  it("returns undefined for non-string non-object args", () => {
    expect(shellProcessStatusFromArgs(42)).toBeUndefined();
    expect(shellProcessStatusFromArgs(true)).toBeUndefined();
  });
});

describe("runningEventGate", () => {
  it("classifies background shell as live resource only", () => {
    const events = [shellEvent("background")];

    expect(events.some(isLiveRuntimeResourceEvent)).toBe(true);
    expect(sessionHasComposerStopBlockingWork(events, "session-1")).toBe(false);
  });

  it("classifies foreground shell as live and composer-stop-blocking", () => {
    const events = [shellEvent("running")];

    expect(events.some(isLiveRuntimeResourceEvent)).toBe(true);
    expect(sessionHasComposerStopBlockingWork(events, "session-1")).toBe(true);
  });

  it.each(["exited", "killed"] as const)(
    "classifies %s shell as settled for every running role",
    (shellProcessStatus) => {
      const events = [shellEvent(shellProcessStatus)];

      expect(events.some(isLiveRuntimeResourceEvent)).toBe(false);
      expect(sessionHasComposerStopBlockingWork(events, "session-1")).toBe(
        false
      );
    }
  );

  it("ignores stale running tools after the runtime is terminal", () => {
    const events = [shellEvent("running")];

    expect(
      sessionHasComposerStopBlockingWork(events, "session-1", "completed")
    ).toBe(false);
    expect(
      sessionHasComposerStopBlockingWork(events, "session-1", "failed")
    ).toBe(false);
  });

  it("ignores stale running tools when runtime is idle (post-stop fallback)", () => {
    const events = [shellEvent("running")];

    expect(
      sessionHasComposerStopBlockingWork(events, "session-1", "idle")
    ).toBe(false);
  });

  it("classifies hidden running status as live but not composer-stop-blocking", () => {
    const events = [hiddenStatusEvent()];

    expect(events.some(isLiveRuntimeResourceEvent)).toBe(true);
    expect(sessionHasComposerStopBlockingWork(events, "session-1")).toBe(false);
  });
});

function userEvent(id: string): SessionEvent {
  return {
    id,
    sessionId: "session-1",
    source: "user",
    createdAt: new Date().toISOString(),
    actionType: "raw",
    functionName: "user_message",
    displayStatus: "completed",
    displayVariant: "message",
  } as unknown as SessionEvent;
}

function settledToolEvent(id: string): SessionEvent {
  return {
    id,
    sessionId: "session-1",
    source: "assistant",
    createdAt: new Date().toISOString(),
    actionType: "tool_call",
    functionName: "code_search",
    displayStatus: "completed",
    displayVariant: "tool_call",
    args: {},
  } as unknown as SessionEvent;
}

function awaitOutputEvent(
  displayStatus: "running" | "completed",
  command: "wait_for" | "monitor" = "wait_for"
): SessionEvent {
  return {
    id: `await-${command}-${displayStatus}`,
    sessionId: "session-1",
    source: "assistant",
    createdAt: new Date().toISOString(),
    actionType: "tool_call",
    functionName: "await_output",
    uiCanonical: "await_output",
    displayStatus,
    displayVariant: "tool_call",
    args: { command, handles: ["pid-123"] },
  } as unknown as SessionEvent;
}

describe("hasLiveRuntimeResourceInLatestTurn", () => {
  it("detects a running event in the latest turn", () => {
    const events = [
      userEvent("u1"),
      settledToolEvent("t1"),
      shellEvent("running"),
    ];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(true);
  });

  it("returns false when the latest turn is fully settled", () => {
    const events = [userEvent("u1"), settledToolEvent("t1")];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(false);
  });

  it("ignores zombie running events from earlier turns", () => {
    // The regression: a frozen shellProcessStatus="running" event in an
    // old turn must not suppress the footer for the current turn.
    const events = [
      userEvent("u1"),
      shellEvent("running"),
      userEvent("u2"),
      settledToolEvent("t2"),
    ];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(false);
  });

  it("ignores old-turn background shells (pinned dev servers)", () => {
    const events = [
      userEvent("u1"),
      shellEvent("background"),
      userEvent("u2"),
      settledToolEvent("t2"),
    ];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(false);
  });

  it("scans the whole array when no user message exists", () => {
    const events = [settledToolEvent("t1"), shellEvent("running")];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(true);
  });

  it("treats a running await_output wait_for as live activity (watchdog must not kill it)", () => {
    // Under the unified model a blocked wait IS genuine activity, so the
    // watchdog input is true. The footer is hidden separately via the
    // selfIndicating classification, not by pretending nothing is live.
    const events = [userEvent("u1"), awaitOutputEvent("running")];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(true);
  });

  it("still detects other running tools alongside a running await_output", () => {
    const events = [
      userEvent("u1"),
      awaitOutputEvent("running"),
      shellEvent("running"),
    ];
    expect(hasLiveRuntimeResourceInLatestTurn(events)).toBe(true);
  });
});

describe("classifyLatestTurnActivity (single source of truth)", () => {
  it("idle when the latest turn is fully settled", () => {
    expect(
      classifyLatestTurnActivity([userEvent("u1"), settledToolEvent("t1")])
    ).toBe("idle");
  });

  it("selfIndicating for a running wait_for (its own countdown is the indicator)", () => {
    expect(
      classifyLatestTurnActivity([userEvent("u1"), awaitOutputEvent("running")])
    ).toBe("selfIndicating");
  });

  it("liveSilent for a running shell (needs the footer to convey activity)", () => {
    expect(
      classifyLatestTurnActivity([userEvent("u1"), shellEvent("running")])
    ).toBe("liveSilent");
  });

  it("liveSilent for a non-blocking monitor await (no countdown of its own)", () => {
    expect(
      classifyLatestTurnActivity([
        userEvent("u1"),
        awaitOutputEvent("running", "monitor"),
      ])
    ).toBe("liveSilent");
  });

  it("a running wait_for dominates a sibling silent resource", () => {
    expect(
      classifyLatestTurnActivity([
        userEvent("u1"),
        shellEvent("running"),
        awaitOutputEvent("running"),
      ])
    ).toBe("selfIndicating");
  });

  // The invariant that the unification exists to guarantee: the two derived
  // booleans agree by construction — `selfIndicating` ALWAYS implies the
  // footer is suppressed AND the watchdog sees live activity, and they are
  // never both reasoning about await_output in opposite directions.
  it("derived booleans are consistent with the classification (no conflict)", () => {
    const cases: SessionEvent[][] = [
      [userEvent("u1"), settledToolEvent("t1")],
      [userEvent("u1"), shellEvent("running")],
      [userEvent("u1"), awaitOutputEvent("running")],
      [userEvent("u1"), awaitOutputEvent("running", "monitor")],
      [userEvent("u1"), shellEvent("running"), awaitOutputEvent("running")],
    ];
    for (const events of cases) {
      const kind = classifyLatestTurnActivity(events);
      const live = hasLiveRuntimeResourceInLatestTurn(events);
      const selfIndicating = hasRunningAwaitWaitForInLatestTurn(events);
      expect(live).toBe(kind !== "idle");
      expect(selfIndicating).toBe(kind === "selfIndicating");
      // selfIndicating ⇒ live (a self-indicating wait is, by definition, live).
      if (selfIndicating) expect(live).toBe(true);
    }
  });
});
