import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import { dataSourceConfigAtom } from "@src/store/session/dataSourceConfigAtom";

import { rescanSidebarSessions } from "./sidebarSessionRefresh";

const mocks = vi.hoisted(() => ({
  externalHistoryRescanSources: vi.fn(),
  loadExternalHistorySidebarSessions: vi.fn(),
  loadSessionRoster: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/externalHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/externalHistory")>()),
  externalHistoryRescanSources: mocks.externalHistoryRescanSources,
}));

vi.mock("@src/store/session", () => ({
  loadExternalHistorySidebarSessions: mocks.loadExternalHistorySidebarSessions,
  loadSessionRoster: mocks.loadSessionRoster,
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => {
    if (!mocks.store) throw new Error("Test store not initialized");
    return mocks.store;
  },
}));

describe("rescanSidebarSessions", () => {
  beforeEach(() => {
    mocks.store = createStore();
    mocks.externalHistoryRescanSources
      .mockReset()
      .mockImplementation(async (sourceIds: string[]) => ({
        changedSources: sourceIds,
      }));
    mocks.loadExternalHistorySidebarSessions
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.loadSessionRoster.mockReset().mockResolvedValue(undefined);
  });

  it("rescans every enabled external source before reloading the sidebar", async () => {
    mocks.store?.set(dataSourceConfigAtom, {
      warp: { enabled: false, frequency: "default", lastScannedAt: null },
    });

    await rescanSidebarSessions();

    const expectedSources = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(
      ({ sourceId }) => sourceId
    ).filter((sourceId) => sourceId !== "warp");
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledWith(
      expectedSources
    );
    expect(mocks.loadExternalHistorySidebarSessions).toHaveBeenCalledOnce();
    expect(mocks.loadSessionRoster).not.toHaveBeenCalled();
    expect(
      mocks.externalHistoryRescanSources.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.loadExternalHistorySidebarSessions.mock.invocationCallOrder[0]
    );
    expect(
      mocks.store?.get(dataSourceConfigAtom).warp.lastScannedAt
    ).toBeNull();
    expect(
      mocks.store?.get(dataSourceConfigAtom).codex_app.lastScannedAt
    ).toEqual(expect.any(Number));
  });

  it("skips the sidebar reload when the incremental rescan changed nothing", async () => {
    mocks.externalHistoryRescanSources.mockResolvedValueOnce({
      changedSources: [],
    });

    await rescanSidebarSessions();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledOnce();
    expect(mocks.loadExternalHistorySidebarSessions).not.toHaveBeenCalled();
    expect(mocks.loadSessionRoster).not.toHaveBeenCalled();
  });
});
