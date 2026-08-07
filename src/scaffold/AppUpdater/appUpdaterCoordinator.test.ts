import type { Update } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppUpdaterCoordinator } from "./appUpdaterCoordinator";

function createUpdate(version = "1.1.22"): Update {
  return {
    available: true,
    close: vi.fn().mockResolvedValue(undefined),
    currentVersion: "1.1.21",
    download: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    version,
  } as unknown as Update;
}

describe("AppUpdaterCoordinator", () => {
  let now: number;
  let check: ReturnType<typeof vi.fn>;
  let coordinator: AppUpdaterCoordinator;

  beforeEach(() => {
    now = 10_000;
    check = vi.fn();
    coordinator = new AppUpdaterCoordinator({
      check,
      downloadTimeoutMs: 5 * 60_000,
      getVersion: vi.fn().mockResolvedValue("1.1.21"),
      minCheckIntervalMs: 5_000,
      now: () => now,
      onStateChange: vi.fn(),
    });
  });

  it("reuses a recent result and lets force bypass the throttle", async () => {
    const update = createUpdate();
    check.mockResolvedValue(update);

    await expect(coordinator.checkForUpdate()).resolves.toMatchObject({
      update,
      fromCache: false,
    });
    now += 1_000;
    await expect(coordinator.checkForUpdate()).resolves.toMatchObject({
      update,
      fromCache: true,
    });
    await coordinator.checkForUpdate(true);

    expect(check).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent checks", async () => {
    let resolveCheck: ((update: Update | null) => void) | undefined;
    check.mockReturnValue(
      new Promise<Update | null>((resolve) => {
        resolveCheck = resolve;
      })
    );

    const first = coordinator.checkForUpdate();
    const second = coordinator.checkForUpdate(true);
    resolveCheck?.(createUpdate());

    await Promise.all([first, second]);
    expect(check).toHaveBeenCalledOnce();
  });

  it("keeps a successful cached update when a silent refresh fails", async () => {
    const update = createUpdate();
    check
      .mockResolvedValueOnce(update)
      .mockRejectedValueOnce(new Error("offline"));
    await coordinator.checkForUpdate();
    now += 10_000;

    await expect(coordinator.checkForUpdate(true)).rejects.toThrow("offline");

    expect(coordinator.getAvailableUpdate()).toBe(update);
    expect(coordinator.getState()).toMatchObject({
      phase: "failed",
      update,
      error: "offline",
    });
  });

  it("downloads once and installs the prepared package without downloading twice", async () => {
    const update = createUpdate();
    check.mockResolvedValue(update);
    await coordinator.checkForUpdate();

    await coordinator.downloadAvailableUpdate();
    await coordinator.downloadAvailableUpdate();
    await coordinator.installAvailableUpdate();

    expect(update.download).toHaveBeenCalledWith(undefined, {
      timeout: 5 * 60_000,
    });
    expect(update.install).toHaveBeenCalledOnce();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("lets only the install owner continue to relaunch", async () => {
    const update = createUpdate();
    let resolveInstall: (() => void) | undefined;
    vi.mocked(update.downloadAndInstall).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInstall = resolve;
      })
    );
    check.mockResolvedValue(update);
    await coordinator.checkForUpdate();

    const first = coordinator.installAvailableUpdate();
    const second = coordinator.installAvailableUpdate();
    resolveInstall?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(update.downloadAndInstall).toHaveBeenCalledWith(undefined, {
      timeout: 5 * 60_000,
    });
  });
});
