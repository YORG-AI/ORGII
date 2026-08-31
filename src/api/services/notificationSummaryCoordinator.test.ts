import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackgroundCompletionSummary,
  NotificationSettings,
} from "@src/types/ui/notification";

import { BackgroundCompletionSummaryCoordinator } from "./notificationSummaryCoordinator";

function quietSettings(
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
      enabled: true,
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
  return {
    ...base,
    ...overrides,
    quietHours: { ...base.quietHours, ...overrides.quietHours },
    categories: { ...base.categories, ...overrides.categories },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BackgroundCompletionSummaryCoordinator", () => {
  it("keeps one boundary timer and flushes one bounded summary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const deliver = vi.fn(
      (
        _summary: BackgroundCompletionSummary,
        _settings: NotificationSettings
      ) => true
    );
    const coordinator = new BackgroundCompletionSummaryCoordinator(deliver);
    const settings = quietSettings();

    coordinator.enqueue({ eventKey: "turn-1", sessionName: "Alpha" }, settings);
    coordinator.enqueue({ eventKey: "turn-2", sessionName: "Beta" }, settings);
    coordinator.enqueue({ eventKey: "turn-3", sessionName: "Gamma" }, settings);
    coordinator.enqueue({ eventKey: "turn-4", sessionName: "Delta" }, settings);

    expect(vi.getTimerCount()).toBe(1);
    expect(coordinator.getPendingSummary()).toEqual({
      count: 4,
      sessionNames: ["Alpha", "Beta", "Gamma"],
    });

    await vi.advanceTimersByTimeAsync(8.5 * 60 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toEqual({
      count: 4,
      sessionNames: ["Alpha", "Beta", "Gamma"],
    });
    expect(coordinator.getPendingSummary()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reschedules the single timer when the user changes the end time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const deliver = vi.fn(
      (
        _summary: BackgroundCompletionSummary,
        _settings: NotificationSettings
      ) => true
    );
    const coordinator = new BackgroundCompletionSummaryCoordinator(deliver);
    const settings = quietSettings();

    coordinator.enqueue({ eventKey: "turn-1", sessionName: "Alpha" }, settings);
    coordinator.configure(
      quietSettings({
        quietHours: { ...settings.quietHours, end: "07:00" },
      })
    );
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(7.5 * 60 * 60 * 1000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops pending work and clears timers when summaries are disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const deliver = vi.fn();
    const coordinator = new BackgroundCompletionSummaryCoordinator(deliver);

    coordinator.enqueue(
      { eventKey: "turn-1", sessionName: "Alpha" },
      quietSettings()
    );
    coordinator.configure(
      quietSettings({ backgroundCompletionSummary: false })
    );

    expect(coordinator.getPendingSummary()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("clears retained state on dispose", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const coordinator = new BackgroundCompletionSummaryCoordinator(vi.fn());
    coordinator.enqueue(
      { eventKey: "turn-1", sessionName: "Alpha" },
      quietSettings()
    );

    coordinator.dispose();
    expect(coordinator.getPendingSummary()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps queued completions when obsolete mute preferences are present", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const coordinator = new BackgroundCompletionSummaryCoordinator(vi.fn());
    const settings = quietSettings();

    coordinator.enqueue({ eventKey: "turn-1", sessionName: "Alpha" }, settings);
    coordinator.enqueue({ eventKey: "turn-2", sessionName: "Beta" }, settings);
    const obsoleteSettings = { ...quietSettings(), mutedSessionIds: ["1"] };
    coordinator.configure(obsoleteSettings);

    expect(coordinator.getPendingSummary()).toEqual({
      count: 2,
      sessionNames: ["Alpha", "Beta"],
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("deduplicates one turn for the full queued lifetime", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const coordinator = new BackgroundCompletionSummaryCoordinator(() => true);
    const settings = quietSettings();

    coordinator.enqueue(
      { eventKey: "session-1:turn-1", sessionName: "Alpha" },
      settings
    );
    coordinator.enqueue(
      { eventKey: "session-1:turn-1", sessionName: "Alpha" },
      settings
    );
    coordinator.enqueue(
      { eventKey: "session-1:turn-2", sessionName: "Alpha" },
      settings
    );

    expect(coordinator.getPendingSummary()).toEqual({
      count: 2,
      sessionNames: ["Alpha"],
    });
  });

  it("retains an unacknowledged summary until an external retry succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const deliver = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const coordinator = new BackgroundCompletionSummaryCoordinator(deliver);
    const settings = quietSettings();

    coordinator.enqueue({ eventKey: "turn-1", sessionName: "Alpha" }, settings);
    await vi.advanceTimersByTimeAsync(8.5 * 60 * 60 * 1000);
    expect(coordinator.getPendingSummary()?.count).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    coordinator.configure(
      quietSettings({ quietHours: { ...settings.quietHours, enabled: false } })
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(coordinator.getPendingSummary()).toBeNull();
  });

  it("keeps a bounded sanitized snapshot when delivery throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const coordinator = new BackgroundCompletionSummaryCoordinator(() => {
      throw new Error("delivery failed");
    });
    const settings = quietSettings();

    coordinator.enqueue(
      {
        eventKey: "turn-1",
        sessionName: `  ${"A".repeat(160)}  `,
      },
      settings
    );
    await vi.advanceTimersByTimeAsync(8.5 * 60 * 60 * 1000);

    expect(coordinator.getPendingSummary()).toEqual({
      count: 1,
      sessionNames: ["A".repeat(120)],
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
