import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotificationSettings } from "@src/types/ui/notification";

import {
  checkNotificationPermission,
  disposeNotificationRuntime,
  listenForSystemNotificationActions,
  notifyAgentApproval,
  notifyError,
  notifyTaskCompletion,
  notifyTeamInbox,
  registerTeamInboxNotificationActionType,
  sendSystemNotification,
  sendTestNotification,
  setDockBadge,
} from "./notification";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  playNotificationSound: vi.fn(async () => true),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(async () => undefined),
  onAction: vi.fn(),
  registerActionTypes: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
  onAction: mocks.onAction,
  registerActionTypes: mocks.registerActionTypes,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("./notificationSound", () => ({
  playNotificationSound: mocks.playNotificationSound,
  unlockNotificationSound: vi.fn(async () => true),
}));

const settings: NotificationSettings = {
  enabled: true,
  systemNotificationEnabled: false,
  dockBadgeEnabled: false,
  soundEnabled: true,
  soundPreset: "bell",
  soundVolume: 42,
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

describe("notification service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendNotification.mockResolvedValue(undefined);
    mocks.playNotificationSound.mockResolvedValue(true);
  });

  afterEach(() => {
    disposeNotificationRuntime();
    vi.useRealTimers();
  });

  it("preserves the Rust permission tri-state", async () => {
    mocks.invoke.mockResolvedValueOnce("unknown");

    await expect(checkNotificationPermission()).resolves.toBe("unknown");
    expect(mocks.invoke).toHaveBeenCalledWith("check_notification_permission");
    expect(mocks.isPermissionGranted).not.toHaveBeenCalled();
  });

  it("does not mislabel a boolean fallback as denied", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
    mocks.isPermissionGranted.mockResolvedValueOnce(false);

    await expect(checkNotificationPermission()).resolves.toBe("unknown");
  });

  it.each([
    ["task completion", () => notifyTaskCompletion("Done", settings)],
    ["approval", () => notifyAgentApproval("Approve", settings)],
    ["error", () => notifyError("Failed", settings)],
  ])("uses the selected preset for %s notifications", async (_name, run) => {
    await run();

    expect(mocks.playNotificationSound).toHaveBeenCalledTimes(1);
    expect(mocks.playNotificationSound).toHaveBeenCalledWith({
      preset: "bell",
      volume: 42,
    });
  });

  it("uses the selected preset for the test notification", async () => {
    await sendTestNotification(settings);

    expect(mocks.playNotificationSound).toHaveBeenCalledWith({
      preset: "bell",
      volume: 42,
    });
  });

  it("gates Team Inbox delivery on the master and category settings", async () => {
    await notifyTeamInbox("New assignment", "Review it", {
      ...settings,
      enabled: false,
    });
    await notifyTeamInbox("New assignment", "Review it", {
      ...settings,
      categories: { ...settings.categories, teamInbox: false },
    });

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.playNotificationSound).not.toHaveBeenCalled();
  });

  it("falls back to the Rust send boundary exactly once", async () => {
    mocks.sendNotification.mockRejectedValueOnce(new Error("plugin failed"));
    mocks.invoke.mockResolvedValueOnce(undefined);

    await expect(sendSystemNotification("Title", "Body")).resolves.toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("send_notification", {
      title: "Title",
      body: "Body",
    });
  });

  it("preserves navigation metadata on the sent notification", async () => {
    await sendSystemNotification("Assigned", "Review it", {
      orgiiTarget: "team-inbox",
      teamInboxItemKey: "assigned_work_item:WI-1",
    });

    expect(mocks.sendNotification).toHaveBeenLastCalledWith({
      title: "Assigned",
      body: "Review it",
      extra: {
        orgiiTarget: "team-inbox",
        teamInboxItemKey: "assigned_work_item:WI-1",
      },
      actionTypeId: undefined,
      autoCancel: true,
    });
  });

  it("keeps the mobile-only action entry points inert on desktop", async () => {
    const handler = vi.fn();

    await registerTeamInboxNotificationActionType("View");
    expect(mocks.registerActionTypes).not.toHaveBeenCalled();

    const dispose = await listenForSystemNotificationActions(handler);
    expect(mocks.onAction).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it("projects positive and cleared dock badge values", async () => {
    mocks.invoke.mockResolvedValue(undefined);

    await setDockBadge(7.9);
    await setDockBadge(0);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "set_dock_badge", {
      count: 7,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "set_dock_badge", {
      count: null,
    });
  });

  it("disposes retained background-summary timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 25, 23, 30));
    const quietSettings: NotificationSettings = {
      ...settings,
      quietHours: {
        ...settings.quietHours,
        enabled: true,
      },
    };

    await expect(
      notifyTaskCompletion("Done", quietSettings, {
        context: {
          sessionId: "summary-session",
          background: true,
          eventKey: "summary-dispose-test",
        },
        summaryLabel: "Summary session",
      })
    ).resolves.toMatchObject({ disposition: "deferred" });
    expect(vi.getTimerCount()).toBe(1);

    disposeNotificationRuntime();
    expect(vi.getTimerCount()).toBe(0);
  });
});
