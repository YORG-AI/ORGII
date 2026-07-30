import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkNotificationPermission,
  notifyTeamInbox,
  sendSystemNotification,
  setDockBadge,
} from "./notification";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const SETTINGS = {
  enabled: true,
  systemNotificationEnabled: true,
  dockBadgeEnabled: true,
  completionSound: false,
  soundVolume: 70,
  categories: {
    taskCompletion: true,
    errors: true,
    teamInbox: true,
  },
};

describe("notification service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("gates Team Inbox delivery on the master and category settings", async () => {
    await notifyTeamInbox("New assignment", "Review it", {
      ...SETTINGS,
      enabled: false,
    });
    await notifyTeamInbox("New assignment", "Review it", {
      ...SETTINGS,
      categories: { ...SETTINGS.categories, teamInbox: false },
    });

    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("falls back to the Rust send boundary exactly once", async () => {
    mocks.sendNotification.mockRejectedValueOnce(new Error("plugin failed"));
    mocks.invoke.mockResolvedValueOnce(undefined);

    await expect(sendSystemNotification("Title", "Body")).resolves.toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("send_notification", {
      title: "Title",
      body: "Body",
    });
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
});
