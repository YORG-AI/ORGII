import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdatesManually, installAvailableAppUpdate } from "./index";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  messageSuccess: vi.fn(),
  relaunch: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

vi.mock("@src/components/Message", () => ({
  default: {
    error: mocks.messageError,
    info: mocks.messageInfo,
    success: mocks.messageSuccess,
  },
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@src/i18n", () => ({
  default: {
    t: (
      _key: string,
      defaultValue: string,
      values?: Record<string, string | number>
    ) =>
      defaultValue.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(values?.[name] ?? "")
      ),
  },
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({
    get: mocks.storeGet,
    set: mocks.storeSet,
  }),
}));

describe("AppUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeGet.mockReturnValue(null);
  });

  it("checks for updates without requiring a browser-exposed Tauri global", async () => {
    const update = {
      available: true,
      currentVersion: "1.1.19",
      downloadAndInstall: vi.fn(),
      version: "1.1.20",
    };
    mocks.getVersion.mockResolvedValue("1.1.19");
    mocks.check.mockResolvedValue(update);

    await expect(checkForUpdatesManually()).resolves.toBe(update);

    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30_000 });
    expect(mocks.messageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Version 1.1.20 is ready to download.",
        title: "Update available",
      })
    );
  });

  it("checks, installs, and relaunches when no update is cached", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    mocks.getVersion.mockResolvedValue("1.1.19");
    mocks.check.mockResolvedValue({
      available: true,
      currentVersion: "1.1.19",
      downloadAndInstall,
      version: "1.1.20",
    });

    await installAvailableAppUpdate();

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(downloadAndInstall).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 5 * 60_000,
    });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("surfaces a retry action when the update download times out", async () => {
    const downloadAndInstall = vi
      .fn()
      .mockRejectedValue(new Error("request timed out"));
    mocks.getVersion.mockResolvedValue("1.1.23");
    mocks.check.mockResolvedValue({
      available: true,
      currentVersion: "1.1.23",
      downloadAndInstall,
      version: "1.1.24",
    });

    await installAvailableAppUpdate();

    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.messageError).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "The download timed out. Check your network or proxy, then retry.",
        duration: 0,
        title: "Update install failed",
        cancel: expect.objectContaining({
          closeOnClick: false,
          label: "Retry",
        }),
      })
    );
    expect(mocks.storeSet).toHaveBeenLastCalledWith(expect.anything(), false);
  });
});
