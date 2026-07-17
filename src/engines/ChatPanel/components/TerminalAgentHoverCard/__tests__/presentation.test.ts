import { describe, expect, it } from "vitest";

import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";

import {
  formatTerminalAgentDuration,
  getHermesApprovalNotificationBody,
  isExternalHermesNotificationOwner,
  isHermesApprovalNotificationFor,
  isHermesTerminalBackground,
  shouldNotifyHermesApproval,
} from "../presentation";

describe("Hermes approval notification presentation", () => {
  it("notifies once when a background terminal enters blocked", () => {
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.RUNNING,
        TERMINAL_AGENT_STATUS.BLOCKED,
        true
      )
    ).toBe(true);
  });

  it("does not notify for repeated blocked events or a foreground app", () => {
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.BLOCKED,
        TERMINAL_AGENT_STATUS.BLOCKED,
        true
      )
    ).toBe(false);
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.RUNNING,
        TERMINAL_AGENT_STATUS.BLOCKED,
        false
      )
    ).toBe(false);
  });

  it("notifies when the Hermes tab is inactive in a focused window", () => {
    const isBackground = isHermesTerminalBackground(false, false, true);
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.RUNNING,
        TERMINAL_AGENT_STATUS.BLOCKED,
        isBackground
      )
    ).toBe(true);
  });

  it("assigns external Hermes notifications to the main window only", () => {
    expect(isExternalHermesNotificationOwner("main")).toBe(true);
    expect(isExternalHermesNotificationOwner("workspace-2")).toBe(false);
  });

  it("prefers the safe preview for the notification body", () => {
    expect(
      getHermesApprovalNotificationBody({
        toolName: "terminal",
        toolInputPreview: "Command needs elevated access",
      })
    ).toBe("Command needs elevated access");
  });

  it("formats short and long tool durations", () => {
    expect(formatTerminalAgentDuration(420)).toBe("420 ms");
    expect(formatTerminalAgentDuration(1_250)).toBe("1.3 s");
    expect(formatTerminalAgentDuration(65_000)).toBe("1m 5s");
  });

  it("only accepts notification actions for the originating terminal", () => {
    const extra = {
      kind: "hermes-approval",
      tabId: "tab-a",
      terminalSessionId: "chatpanel-a",
    };

    expect(isHermesApprovalNotificationFor(extra, "tab-a", "chatpanel-a")).toBe(
      true
    );
    expect(isHermesApprovalNotificationFor(extra, "tab-b", "chatpanel-a")).toBe(
      false
    );
  });
});
