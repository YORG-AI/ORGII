import { describe, expect, it } from "vitest";

import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";

import {
  formatTerminalAgentDuration,
  getHermesApprovalNotificationBody,
  isHermesApprovalNotificationFor,
  shouldNotifyHermesApproval,
} from "../presentation";

describe("Hermes approval notification presentation", () => {
  it("notifies once when a background terminal enters blocked", () => {
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.RUNNING,
        TERMINAL_AGENT_STATUS.BLOCKED,
        true,
        false
      )
    ).toBe(true);
  });

  it("does not notify for repeated blocked events or a foreground app", () => {
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.BLOCKED,
        TERMINAL_AGENT_STATUS.BLOCKED,
        true,
        false
      )
    ).toBe(false);
    expect(
      shouldNotifyHermesApproval(
        TERMINAL_AGENT_STATUS.RUNNING,
        TERMINAL_AGENT_STATUS.BLOCKED,
        false,
        true
      )
    ).toBe(false);
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
