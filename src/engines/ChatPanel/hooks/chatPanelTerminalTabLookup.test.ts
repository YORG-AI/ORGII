/**
 * findOpenCliTerminalTab — regression tests for the duplicate-CLI-terminal
 * lookup extracted from useChatPanelTabsController's handleOpenCliTerminal.
 */
import { describe, expect, it } from "vitest";

import type { TerminalSession } from "@src/engines/TerminalCore/types";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

import { findOpenCliTerminalTab } from "./chatPanelTerminalTabLookup";

function terminalTab(overrides: Partial<ChatPanelTab> = {}): ChatPanelTab {
  return {
    id: "tab-1",
    type: "terminal",
    title: "Claude Code",
    terminalSessionId: "chatpanel-session-1",
    ...overrides,
  };
}

function terminalSession(
  overrides: Partial<TerminalSession> = {}
): TerminalSession {
  return {
    id: "chatpanel-session-1",
    name: "Claude Code",
    isActive: false,
    cliAgentType: "claude_code",
    agentCommand: "claude --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed",
    cwd: "/tmp/project",
    ...overrides,
  };
}

describe("findOpenCliTerminalTab", () => {
  it("finds an existing tab launched with the same agent, command, and cwd", () => {
    const tabs = [terminalTab()];
    const sessions = [terminalSession()];

    const found = findOpenCliTerminalTab(tabs, sessions, {
      cliAgentType: "claude_code",
      command: "claude --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed",
      cwd: "/tmp/project",
    });

    expect(found?.id).toBe("tab-1");
  });

  it("ignores a tab bound to a different resume command (different agentSessionId behind the scenes)", () => {
    const tabs = [terminalTab()];
    const sessions = [terminalSession()];

    const found = findOpenCliTerminalTab(tabs, sessions, {
      cliAgentType: "claude_code",
      command: "claude --resume a-different-session-uuid",
      cwd: "/tmp/project",
    });

    expect(found).toBeUndefined();
  });

  it("ignores a tab in a different cwd even with an identical command", () => {
    const tabs = [terminalTab()];
    const sessions = [terminalSession()];

    const found = findOpenCliTerminalTab(tabs, sessions, {
      cliAgentType: "claude_code",
      command: "claude --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed",
      cwd: "/tmp/other-project",
    });

    expect(found).toBeUndefined();
  });

  it("ignores non-terminal tabs and terminal tabs with no backing session", () => {
    const tabs = [
      terminalTab({
        id: "session-tab",
        type: "session",
        terminalSessionId: undefined,
      }),
      terminalTab({ id: "orphaned-terminal-tab", terminalSessionId: "gone" }),
    ];
    const sessions = [terminalSession()];

    const found = findOpenCliTerminalTab(tabs, sessions, {
      cliAgentType: "claude_code",
      command: "claude --resume b52f4220-8b0b-46c5-8ee6-001ebf91c6ed",
      cwd: "/tmp/project",
    });

    expect(found).toBeUndefined();
  });

  it("returns undefined when the new launch has no resolved command", () => {
    const tabs = [terminalTab()];
    const sessions = [terminalSession()];

    const found = findOpenCliTerminalTab(tabs, sessions, {
      cliAgentType: "claude_code",
      command: "   ",
      cwd: "/tmp/project",
    });

    expect(found).toBeUndefined();
  });
});
