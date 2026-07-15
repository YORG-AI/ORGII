import { describe, expect, it } from "vitest";

import {
  TERMINAL_AGENT_STATUS,
  type TerminalSession,
} from "@src/engines/TerminalCore/types";

import { deriveAgentStatus } from "../useTerminalProcessPoller";

function hermesSession(
  overrides: Partial<TerminalSession> = {}
): TerminalSession {
  return {
    id: "chatpanel-hermes",
    name: "Hermes",
    isActive: true,
    expectedProcess: "hermes",
    ...overrides,
  };
}

describe("deriveAgentStatus", () => {
  it("uses foreground process detection before a hook event arrives", () => {
    expect(deriveAgentStatus(hermesSession(), "hermes")).toBe(
      TERMINAL_AGENT_STATUS.RUNNING
    );
    expect(deriveAgentStatus(hermesSession(), "zsh")).toBe(
      TERMINAL_AGENT_STATUS.WAITING
    );
  });

  it("does not overwrite authoritative Hermes hook status", () => {
    const session = hermesSession({
      agentStatus: TERMINAL_AGENT_STATUS.WAITING,
      agentStatusSource: "hook",
    });

    expect(deriveAgentStatus(session, "hermes")).toBe(
      TERMINAL_AGENT_STATUS.WAITING
    );
  });
});
