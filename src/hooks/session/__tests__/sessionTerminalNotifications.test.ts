import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import Message from "@src/components/Message";
import type { NotificationSettings } from "@src/types/ui/notification";

import {
  deliverSessionTerminalNotification,
  shouldDeliverSessionTerminalNotification,
} from "../sessionTerminalNotifications";

vi.mock("@src/components/Message", () => ({
  default: { warning: vi.fn() },
}));

describe("shouldDeliverSessionTerminalNotification", () => {
  it("delivers only a new terminal transition", () => {
    expect(
      shouldDeliverSessionTerminalNotification("running", "completed")
    ).toBe(true);
    expect(
      shouldDeliverSessionTerminalNotification("completed", "completed")
    ).toBe(false);
    expect(
      shouldDeliverSessionTerminalNotification("failed", "completed")
    ).toBe(false);
    expect(shouldDeliverSessionTerminalNotification("running", "working")).toBe(
      false
    );
  });
});

describe("deliverSessionTerminalNotification", () => {
  it("ignores removed mute preferences for cancellation while honoring the master toggle", () => {
    const settings: NotificationSettings = {
      enabled: true,
      systemNotificationEnabled: false,
      dockBadgeEnabled: false,
      soundEnabled: false,
      soundPreset: "classic",
      soundVolume: 70,
      criticalOnly: false,
      quietHours: {
        enabled: false,
        start: "23:00",
        end: "08:00",
        allowCritical: true,
      },
      backgroundCompletionSummary: true,
      categories: {
        taskCompletion: true,
        agentApproval: true,
        errors: true,
        teamInbox: true,
      },
    };
    const obsoleteSettings = { ...settings, mutedSessionIds: ["session-a"] };
    const event = {
      sessionId: "session-a",
      sessionName: "Session A",
      status: "cancelled",
      attentionRequired: true,
    };
    const translate = ((key: string) => key) as TFunction;

    deliverSessionTerminalNotification(event, obsoleteSettings, translate);
    expect(Message.warning).toHaveBeenCalledOnce();
    deliverSessionTerminalNotification(
      event,
      { ...obsoleteSettings, enabled: false },
      translate
    );
    expect(Message.warning).toHaveBeenCalledOnce();
  });
});
