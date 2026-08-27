import { describe, expect, it } from "vitest";

import type { NotificationSettings } from "@src/types/ui/notification";

import {
  NotificationEventDeduper,
  NotificationRunTracker,
  evaluateNotificationPolicy,
  isNotificationAttentionRequired,
  isQuietHoursActive,
  isSuccessfulNotificationTurnStatus,
  nextQuietHoursEnd,
} from "./notificationPolicy";

function attentionDocument(
  visibilityState: DocumentVisibilityState,
  focused: boolean
): Pick<Document, "visibilityState" | "hasFocus"> {
  return {
    visibilityState,
    hasFocus: () => focused,
  };
}

function makeSettings(
  overrides: Partial<NotificationSettings> = {}
): NotificationSettings {
  const base: NotificationSettings = {
    enabled: true,
    systemNotificationEnabled: true,
    dockBadgeEnabled: false,
    soundEnabled: true,
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
    mutedSessionIds: [],
    categories: {
      taskCompletion: true,
      agentApproval: true,
      errors: true,
      teamInbox: true,
    },
  };
  return {
    ...base,
    ...overrides,
    quietHours: { ...base.quietHours, ...overrides.quietHours },
    categories: { ...base.categories, ...overrides.categories },
  };
}

describe("quiet-hours time windows", () => {
  it("supports a cross-midnight window with an exclusive end boundary", () => {
    const settings = makeSettings({
      quietHours: {
        enabled: true,
        start: "23:00",
        end: "08:00",
        allowCritical: true,
      },
    });

    expect(isQuietHoursActive(settings, new Date(2026, 6, 25, 23, 0))).toBe(
      true
    );
    expect(isQuietHoursActive(settings, new Date(2026, 6, 26, 7, 59))).toBe(
      true
    );
    expect(isQuietHoursActive(settings, new Date(2026, 6, 26, 8, 0))).toBe(
      false
    );
    expect(nextQuietHoursEnd(settings, new Date(2026, 6, 25, 23, 30))).toEqual(
      new Date(2026, 6, 26, 8, 0)
    );
  });

  it("supports a same-day custom window and treats equal times as disabled", () => {
    const settings = makeSettings({
      quietHours: {
        enabled: true,
        start: "09:15",
        end: "17:45",
        allowCritical: true,
      },
    });
    expect(isQuietHoursActive(settings, new Date(2026, 6, 25, 12, 0))).toBe(
      true
    );
    expect(isQuietHoursActive(settings, new Date(2026, 6, 25, 18, 0))).toBe(
      false
    );

    settings.quietHours.start = "09:15";
    settings.quietHours.end = "09:15";
    expect(isQuietHoursActive(settings, new Date(2026, 6, 25, 9, 15))).toBe(
      false
    );
  });
});

describe("evaluateNotificationPolicy", () => {
  it("suppresses every alert for a muted session", () => {
    const decision = evaluateNotificationPolicy(
      {
        category: "errors",
        context: { sessionId: "session-muted" },
        playSound: false,
      },
      makeSettings({ mutedSessionIds: ["session-muted"] })
    );
    expect(decision).toMatchObject({
      disposition: "suppress",
      reason: "session-muted",
    });
  });

  it("critical-only mode keeps approvals and errors but suppresses completion", () => {
    const settings = makeSettings({ criticalOnly: true });
    expect(
      evaluateNotificationPolicy(
        { category: "taskCompletion", playSound: true },
        settings
      ).reason
    ).toBe("critical-only");
    expect(
      evaluateNotificationPolicy(
        { category: "agentApproval", playSound: true },
        settings
      ).disposition
    ).toBe("deliver");
    expect(
      evaluateNotificationPolicy(
        { category: "errors", playSound: false },
        settings
      ).disposition
    ).toBe("deliver");
  });

  it("suppresses completion alerts for an attended foreground session", () => {
    expect(
      evaluateNotificationPolicy(
        {
          category: "taskCompletion",
          context: { sessionId: "active-session", background: false },
          playSound: true,
        },
        makeSettings()
      )
    ).toEqual({
      disposition: "suppress",
      sendSystemNotification: false,
      playSound: false,
      reason: "foreground-session",
    });
  });

  it("delivers completion alerts once the session needs background attention", () => {
    expect(
      evaluateNotificationPolicy(
        {
          category: "taskCompletion",
          context: { sessionId: "background-session", background: true },
          playSound: true,
        },
        makeSettings()
      )
    ).toEqual({
      disposition: "deliver",
      sendSystemNotification: true,
      playSound: true,
    });
  });

  it("keeps approval and error alerts eligible in an attended session", () => {
    for (const category of ["agentApproval", "errors"] as const) {
      expect(
        evaluateNotificationPolicy(
          {
            category,
            context: { sessionId: "active-session", background: false },
            playSound: true,
          },
          makeSettings()
        )
      ).toEqual({
        disposition: "deliver",
        sendSystemNotification: false,
        playSound: true,
      });
    }
  });

  it("defers background completion during quiet hours", () => {
    const decision = evaluateNotificationPolicy(
      {
        category: "taskCompletion",
        context: { sessionId: "session-1", background: true },
        playSound: true,
      },
      makeSettings({
        quietHours: {
          enabled: true,
          start: "23:00",
          end: "08:00",
          allowCritical: true,
        },
      }),
      new Date(2026, 6, 25, 23, 30)
    );
    expect(decision).toMatchObject({
      disposition: "defer",
      playSound: false,
      reason: "quiet-hours",
    });
  });

  it("allows critical system alerts during quiet hours without sound", () => {
    const decision = evaluateNotificationPolicy(
      { category: "agentApproval", playSound: true },
      makeSettings({
        quietHours: {
          enabled: true,
          start: "23:00",
          end: "08:00",
          allowCritical: true,
        },
      }),
      new Date(2026, 6, 25, 23, 30)
    );
    expect(decision).toEqual({
      disposition: "deliver",
      sendSystemNotification: true,
      playSound: false,
    });
  });
});

describe("notification attention state", () => {
  it("requires system attention for background, hidden, or unfocused work", () => {
    expect(
      isNotificationAttentionRequired(true, attentionDocument("visible", true))
    ).toBe(true);
    expect(
      isNotificationAttentionRequired(false, attentionDocument("hidden", true))
    ).toBe(true);
    expect(
      isNotificationAttentionRequired(
        false,
        attentionDocument("visible", false)
      )
    ).toBe(true);
    expect(
      isNotificationAttentionRequired(false, attentionDocument("visible", true))
    ).toBe(false);
  });
});

describe("successful notification turn statuses", () => {
  it("treats completed sessions and idle Agent Org members as finished turns", () => {
    expect(isSuccessfulNotificationTurnStatus("completed")).toBe(true);
    expect(isSuccessfulNotificationTurnStatus("idle")).toBe(true);
    expect(isSuccessfulNotificationTurnStatus("running")).toBe(false);
    expect(isSuccessfulNotificationTurnStatus("failed")).toBe(false);
  });
});

describe("NotificationEventDeduper", () => {
  it("collapses duplicate events, supports run resets, and stays bounded", () => {
    const deduper = new NotificationEventDeduper(100, 2);
    expect(deduper.shouldDeliver("session-1", 0)).toBe(true);
    expect(deduper.shouldDeliver("session-1", 50)).toBe(false);

    deduper.forget("session-1");
    expect(deduper.shouldDeliver("session-1", 60)).toBe(true);
    expect(deduper.shouldDeliver("session-2", 60)).toBe(true);
    expect(deduper.shouldDeliver("session-3", 60)).toBe(true);
    expect(deduper.shouldDeliver("session-1", 61)).toBe(true);

    expect(deduper.shouldDeliver("session-1", 200)).toBe(true);
  });
});

describe("NotificationRunTracker", () => {
  it("keeps duplicate terminal events on one key and advances per real run", () => {
    const tracker = new NotificationRunTracker();
    tracker.markRunning("session-1");
    tracker.markRunning("session-1");

    const first = tracker.terminalEventKey("session-1", "completed");
    expect(tracker.terminalEventKey("session-1", "completed")).toBe(first);

    tracker.markRunning("session-1");
    expect(tracker.terminalEventKey("session-1", "completed")).not.toBe(first);
  });
});
