import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";

import {
  type DataSourceConfigMap,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
} from "../dataSourceConfigAtom";
import { runDataSourceAutoScan } from "../useDataSourceAutoScan";

const mocks = vi.hoisted(() => ({
  externalHistoryRescanSources: vi.fn(),
  loadSidebarSessions: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/externalHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/externalHistory")>()),
  externalHistoryRescanSources: mocks.externalHistoryRescanSources,
}));

vi.mock("../sessionAtom/loaders", () => ({
  loadSidebarSessions: mocks.loadSidebarSessions,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => {
    if (!mocks.store) throw new Error("Test store not initialized");
    return mocks.store;
  },
}));

const NOW = 1_750_000_000_000;

describe("runDataSourceAutoScan", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    mocks.store = createStore();
    mocks.externalHistoryRescanSources.mockReset().mockResolvedValue(undefined);
    mocks.loadSidebarSessions.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("scans enabled non-manual sources immediately at startup", async () => {
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
    expect(mocks.loadSidebarSessions).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(
      mocks.externalHistoryRescanSources.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.loadSidebarSessions.mock.invocationCallOrder[0]);
    expect(mocks.store?.get(dataSourceConfigAtom).codex_app.lastScannedAt).toBe(
      NOW
    );
    expect(
      mocks.store?.get(dataSourceConfigAtom).cline.lastScannedAt
    ).toBeNull();
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
      frequency: "60s",
      lastScannedAt: NOW - 1_000,
    };
    config.cline = {
      enabled: true,
      frequency: "60s",
      lastScannedAt: NOW - 60_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    await runDataSourceAutoScan();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(["cline"]);
    expect(mocks.loadSidebarSessions).toHaveBeenCalledOnce();
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
      frequency: "60s",
      lastScannedAt: null,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    let finishScan: (() => void) | undefined;
    mocks.externalHistoryRescanSources.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishScan = resolve;
        })
    );

    const first = runDataSourceAutoScan(true);
    const second = runDataSourceAutoScan(true);
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledOnce();

    finishScan?.();
    await Promise.all([first, second]);
    expect(mocks.loadSidebarSessions).toHaveBeenCalledOnce();
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
    // Overdue at its 60s cadence but well inside the 10-minute floor.
    config.codex_app = {
      enabled: true,
      frequency: "60s",
      lastScannedAt: NOW - 5 * 60_000,
    };
    // Past the 10-minute floor — scans even unfocused.
    config.cline = {
      enabled: true,
      frequency: "60s",
      lastScannedAt: NOW - 11 * 60_000,
    };
    mocks.store?.set(dataSourceConfigAtom, config);

    await runDataSourceAutoScan(false);

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(["cline"]);
    vi.unstubAllGlobals();
  });
});
