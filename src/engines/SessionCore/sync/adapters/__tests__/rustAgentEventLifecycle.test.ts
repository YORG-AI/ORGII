import { beforeEach, describe, expect, it } from "vitest";

import {
  publishTurnIntentDispatch,
  resetTurnIntentDispatchLifecycleForTests,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  resetTurnLifecycleForTests,
} from "@src/engines/SessionCore/control/turnLifecycle";

import {
  isRustAgentTurnNeutralEvent,
  shouldAcceptRustAgentTerminalAttribution,
} from "../createRustAgentAdapter";

describe("Rust agent event lifecycle classification", () => {
  beforeEach(() => {
    resetTurnIntentDispatchLifecycleForTests();
    resetTurnLifecycleForTests();
  });

  it.each([
    "agent:snapshot_created",
    "agent:file_change",
    "agent:setup_repo_update",
    "agent:heartbeat",
    "agent:computer_use_aborted",
  ])("keeps asynchronous side-channel event %s turn-neutral", (eventType) => {
    expect(isRustAgentTurnNeutralEvent(eventType)).toBe(true);
  });

  it.each([
    "agent:message_delta",
    "agent:thinking_delta",
    "agent:tool_call",
    "agent:tool_result",
  ])("still treats substantive event %s as turn activity", (eventType) => {
    expect(isRustAgentTurnNeutralEvent(eventType)).toBe(false);
  });

  it("fails closed for an unknown or cross-session terminal during a canonical turn", () => {
    const generation = beginTurnDispatch("session-1");
    publishTurnIntentDispatch("active-intent", {
      sessionId: "session-1",
      generation,
    });
    expect(
      shouldAcceptRustAgentTerminalAttribution(
        { turnIntentId: "unknown-intent" },
        "session-1"
      )
    ).toBe(false);

    expect(
      shouldAcceptRustAgentTerminalAttribution(
        { details: { turnIntentId: "unknown-scheduler-error" } },
        "session-1"
      )
    ).toBe(false);

    publishTurnIntentDispatch("known-intent", {
      sessionId: "session-other",
      generation: 4,
    });
    expect(
      shouldAcceptRustAgentTerminalAttribution(
        { turnIntentId: "known-intent" },
        "session-1"
      )
    ).toBe(false);
  });

  it("accepts an exact attributed terminal and the legacy unattributed path", () => {
    const generation = beginTurnDispatch("session-1");
    publishTurnIntentDispatch("known-intent", {
      sessionId: "session-1",
      generation,
    });

    expect(
      shouldAcceptRustAgentTerminalAttribution(
        { turnIntentId: "known-intent" },
        "session-1"
      )
    ).toBe(true);
    expect(shouldAcceptRustAgentTerminalAttribution({}, "session-legacy")).toBe(
      true
    );
    expect(
      shouldAcceptRustAgentTerminalAttribution(
        { turnIntentId: "backend-minted-legacy-intent" },
        "session-legacy"
      )
    ).toBe(true);
  });
});
