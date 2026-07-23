import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";

import {
  type DataSourceConfigMap,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
  dataSourcePresenceAtom,
  externalSessionsEnabledAtom,
} from "../dataSourceConfigAtom";
import {
  nextDataSourceAutoScanDelay,
  runDataSourceAutoScan,
  startDataSourceAutoScanScheduler,
} from "../useDataSourceAutoScan";

const mocks = vi.hoisted(() => ({
  externalCliSourceProbe: vi.fn(),
  externalHistoryRescanSources: vi.fn(),
  loadExternalHistorySidebarSessions: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/externalHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/externalHistory")>()),
  externalCliSourceProbe: mocks.externalCliSourceProbe,
  externalHistoryRescanSources: mocks.externalHistoryRescanSources,
}));

vi.mock("../sessionAtom/loaders", () => ({
  loadExternalHistorySidebarSessions: mocks.loadExternalHistorySidebarSessions,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => {
    if (!mocks.store) throw new Error("Test store not initialized");
    return mocks.store;
  },
}));

const NOW = 1_750_000_000_000;
const SOURCE_PRESENCE_PROBE_INTERVAL_MS = 30 * 60_000;

class VisibilitySourceStub {
  visibilityState: DocumentVisibilityState = "visible";
  private listener: (() => void) | undefined;

  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listener = listener;
  }

  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    if (this.listener === listener) this.listener = undefined;
  }

  setVisibility(visibilityState: DocumentVisibilityState): void {
    this.visibilityState = visibilityState;
    this.listener?.();
  }
}

describe("runDataSourceAutoScan", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.store = createStore();
    mocks.externalCliSourceProbe
      .mockReset()
      .mockImplementation(async (sourceId: string) => ({
        sourceId,
        historyFound: true,
      }));
    mocks.externalHistoryRescanSources
      .mockReset()
      .mockImplementation(async (sourceIds: string[]) => ({
        changedSources: sourceIds,
      }));
    mocks.loadExternalHistorySidebarSessions
      .mockReset()
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("defaults global provider discovery to a ten-minute cadence", () => {
    expect(mocks.store?.get(dataSourceGlobalFrequencyAtom)).toBe("10m");
  });

  it("schedules directly at the next scan or presence deadline", () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.codex_app = {
      enabled: true,
      frequency: "60s",
      lastScannedAt: NOW,
    };

    expect(
      nextDataSourceAutoScanDelay(
        NOW,
        true,
        true,
        config,
        { codex_app: { historyFound: true, checkedAt: NOW } },
        "10m"
      )
    ).toBe(60_000);
    expect(
      nextDataSourceAutoScanDelay(
        NOW,
        false,
        true,
        config,
        { codex_app: { historyFound: true, checkedAt: NOW } },
        "10m"
      )
    ).toBe(10 * 60_000);
  });

  it("parks disabled scheduling and waits for the probe of an absent store", () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "60s",
      lastScannedAt: NOW - 60_000,
    };
    const presence = {
      cursor_ide: { historyFound: false, checkedAt: NOW },
    };

    expect(
      nextDataSourceAutoScanDelay(NOW, true, true, config, presence, "10m")
    ).toBe(SOURCE_PRESENCE_PROBE_INTERVAL_MS);
    expect(
      nextDataSourceAutoScanDelay(NOW, true, false, config, presence, "10m")
    ).toBeNull();
  });

  it("force scans enabled non-manual sources for explicit refreshes", async () => {
    mocks.store?.set(dataSourceGlobalFrequencyAtom, "60s");
    mocks.store?.set(dataSourceConfigAtom, {
      codex_app: {
        enabled: true,
        frequency: "default",
        lastScannedAt: NOW - 1_000,
      },
      cline: { enabled: true, frequency: "manual", lastScannedAt: null },
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });

    await runDataSourceAutoScan(true);

    const expectedSources = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(
      ({ sourceId }) => sourceId
    ).filter((sourceId) => sourceId !== "cline" && sourceId !== "warp");
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledOnce();
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(
      expectedSources
    );
    expect(mocks.loadExternalHistorySidebarSessions).toHaveBeenCalledOnce();
    expect(
      mocks.externalHistoryRescanSources.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.loadExternalHistorySidebarSessions.mock.invocationCallOrder[0]
    );
    expect(mocks.store?.get(dataSourceConfigAtom).codex_app.lastScannedAt).toBe(
      NOW
    );
    expect(
      mocks.store?.get(dataSourceConfigAtom).cline.lastScannedAt
    ).toBeNull();
    expect(mocks.externalCliSourceProbe).not.toHaveBeenCalledWith("cline");
    expect(mocks.externalCliSourceProbe).not.toHaveBeenCalledWith("warp");
  });

  it("presence-probes an absent source at startup without running its importer", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: null,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.externalCliSourceProbe.mockResolvedValue({
      sourceId: "cursor_ide",
      historyFound: false,
    });

    await runDataSourceAutoScan(true);

    expect(mocks.externalCliSourceProbe).toHaveBeenCalledOnce();
    expect(mocks.externalCliSourceProbe).toHaveBeenCalledWith("cursor_ide");
    expect(mocks.externalHistoryRescanSources).not.toHaveBeenCalled();
    expect(mocks.loadExternalHistorySidebarSessions).not.toHaveBeenCalled();
    expect(mocks.store?.get(dataSourcePresenceAtom).cursor_ide).toEqual({
      historyFound: false,
      checkedAt: NOW,
    });
    expect(
      mocks.store?.get(dataSourceConfigAtom).cursor_ide.lastScannedAt
    ).toBe(NOW);
  });

  it("does not re-probe an absent source before the 30-minute interval", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 120_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.store?.set(dataSourcePresenceAtom, {
      cursor_ide: {
        historyFound: false,
        checkedAt: NOW - SOURCE_PRESENCE_PROBE_INTERVAL_MS + 1,
      },
    });

    await runDataSourceAutoScan();

    expect(mocks.externalCliSourceProbe).not.toHaveBeenCalled();
    expect(mocks.externalHistoryRescanSources).not.toHaveBeenCalled();
  });

  it("re-probes an absent source after 30 minutes without running its importer", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 120_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.store?.set(dataSourcePresenceAtom, {
      cursor_ide: {
        historyFound: false,
        checkedAt: NOW - SOURCE_PRESENCE_PROBE_INTERVAL_MS,
      },
    });
    mocks.externalCliSourceProbe.mockResolvedValue({
      sourceId: "cursor_ide",
      historyFound: false,
    });

    await runDataSourceAutoScan();

    expect(mocks.externalCliSourceProbe).toHaveBeenCalledWith("cursor_ide");
    expect(mocks.externalHistoryRescanSources).not.toHaveBeenCalled();
    expect(mocks.store?.get(dataSourcePresenceAtom).cursor_ide.checkedAt).toBe(
      NOW
    );
  });

  it("imports immediately when a 30-minute probe discovers a new store", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "1h",
      lastScannedAt: NOW - 60_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.store?.set(dataSourcePresenceAtom, {
      cursor_ide: {
        historyFound: false,
        checkedAt: NOW - SOURCE_PRESENCE_PROBE_INTERVAL_MS,
      },
    });

    await runDataSourceAutoScan();

    expect(mocks.externalCliSourceProbe).toHaveBeenCalledWith("cursor_ide");
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith([
      "cursor_ide",
    ]);
    expect(mocks.loadExternalHistorySidebarSessions).toHaveBeenCalledOnce();
    expect(mocks.store?.get(dataSourcePresenceAtom).cursor_ide).toEqual({
      historyFound: true,
      checkedAt: NOW,
    });
  });

  it("falls back to a due full scan when the presence probe fails", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.cursor_ide = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 120_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.externalCliSourceProbe.mockRejectedValue(new Error("probe failed"));

    await runDataSourceAutoScan();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith([
      "cursor_ide",
    ]);
    expect(mocks.store?.get(dataSourcePresenceAtom).cursor_ide).toBeUndefined();
  });

  it("does not probe when external sessions are globally disabled", async () => {
    mocks.store?.set(externalSessionsEnabledAtom, false);

    await runDataSourceAutoScan(true);

    expect(mocks.externalCliSourceProbe).not.toHaveBeenCalled();
    expect(mocks.externalHistoryRescanSources).not.toHaveBeenCalled();
  });

  it("scans only sources whose configured cadence has elapsed", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.codex_app = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 1_000,
    };
    config.cline = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 120_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    await runDataSourceAutoScan();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(["cline"]);
    expect(mocks.loadExternalHistorySidebarSessions).toHaveBeenCalledOnce();
  });

  it("does not reload sidebar pages when an incremental scan changed nothing", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.codex_app = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 120_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);
    mocks.externalHistoryRescanSources.mockResolvedValueOnce({
      changedSources: [],
    });

    await runDataSourceAutoScan();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith([
      "codex_app",
    ]);
    expect(mocks.loadExternalHistorySidebarSessions).not.toHaveBeenCalled();
    expect(mocks.store?.get(dataSourceConfigAtom).codex_app.lastScannedAt).toBe(
      NOW
    );
  });

  it("deduplicates overlapping startup passes", async () => {
    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    config.codex_app = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: null,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    let finishScan: (() => void) | undefined;
    mocks.externalHistoryRescanSources.mockImplementation(
      (sourceIds: string[]) =>
        new Promise<{ changedSources: string[] }>((resolve) => {
          finishScan = () => resolve({ changedSources: sourceIds });
        })
    );

    const first = runDataSourceAutoScan(true);
    const second = runDataSourceAutoScan(true);
    await vi.waitFor(() => {
      expect(mocks.externalHistoryRescanSources).toHaveBeenCalledOnce();
    });

    finishScan?.();
    await Promise.all([first, second]);
    expect(mocks.loadExternalHistorySidebarSessions).toHaveBeenCalledOnce();
  });

  it("holds unfocused sources to the 10-minute background floor", async () => {
    // Simulate an unfocused window (node env has no document; stub one).
    vi.stubGlobal("document", {
      hasFocus: () => false,
      hidden: false,
    });

    const config: DataSourceConfigMap = Object.fromEntries(
      IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(({ sourceId }) => [
        sourceId,
        { enabled: false, frequency: "default" as const, lastScannedAt: null },
      ])
    );
    // Overdue at its 120s cadence but well inside the 10-minute floor.
    config.codex_app = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 5 * 60_000,
    };
    // Past the 10-minute floor — scans even unfocused.
    config.cline = {
      enabled: true,
      frequency: "120s",
      lastScannedAt: NOW - 11 * 60_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    await runDataSourceAutoScan(false);

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(["cline"]);
  });
});

describe("startDataSourceAutoScanScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses while hidden, catches up on return, and disposes its timer", async () => {
    vi.useFakeTimers();
    const source = new VisibilitySourceStub();
    const scan = vi.fn().mockResolvedValue(undefined);
    const scheduler = startDataSourceAutoScanScheduler(
      source,
      scan,
      () => 30_000
    );

    expect(scan).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    source.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scan).toHaveBeenCalledTimes(1);

    source.setVisibility("visible");
    expect(scan).toHaveBeenLastCalledWith(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(scan).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    source.setVisibility("visible");
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("defers the cadence-respecting startup pass until an initially hidden app is visible", async () => {
    vi.useFakeTimers();
    const source = new VisibilitySourceStub();
    source.visibilityState = "hidden";
    const scan = vi.fn().mockResolvedValue(undefined);
    const scheduler = startDataSourceAutoScanScheduler(
      source,
      scan,
      () => 30_000
    );

    expect(scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    source.setVisibility("visible");
    expect(scan).toHaveBeenCalledWith(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    scheduler.stop();
  });
});
