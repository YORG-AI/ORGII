import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import { dataSourceConfigAtom } from "@src/store/session/dataSourceConfigAtom";

import { rescanSidebarSessions } from "./sidebarSessionRefresh";

const mocks = vi.hoisted(() => ({
  externalHistoryRescanSources: vi.fn(),
  loadSessionRoster: vi.fn(),
  store: undefined as ReturnType<typeof createStore> | undefined,
}));

vi.mock("@src/api/tauri/externalHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/externalHistory")>()),
  externalHistoryRescanSources: mocks.externalHistoryRescanSources,
}));

vi.mock("@src/store/session", () => ({
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
    mocks.externalHistoryRescanSources.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.loadSessionRoster).toHaveBeenCalledWith({
      forceRefresh: true,
    });
    expect(
      mocks.externalHistoryRescanSources.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.loadSessionRoster.mock.invocationCallOrder[0]);
    expect(
      mocks.store?.get(dataSourceConfigAtom).warp.lastScannedAt
    ).toBeNull();
    expect(
      mocks.store?.get(dataSourceConfigAtom).codex_app.lastScannedAt
    ).toEqual(expect.any(Number));
  });

  it("reloads even when the rescan reports no changes of its own", async () => {
    // Other surfaces sync the same backend cache between explicit refreshes
    // (e.g. a continuation demotion during a foreign sync), so a manual
    // rescan must reload unconditionally rather than trust changedSources.
    mocks.externalHistoryRescanSources.mockResolvedValue({
      changedSources: [],
      sourceSignatures: { codex_app: "1:2026-07-24T05:43:08Z:1" },
    });

    await rescanSidebarSessions();

    expect(mocks.loadSessionRoster).toHaveBeenCalledWith({
      forceRefresh: true,
    });
  });

  it("shares one in-flight rescan across repeated refresh actions", async () => {
    let resolveScan: ((value: undefined) => void) | undefined;
    mocks.externalHistoryRescanSources.mockReturnValue(
      new Promise<undefined>((resolve) => {
        resolveScan = resolve;
      })
    );

    const first = rescanSidebarSessions();
    const second = rescanSidebarSessions();

    expect(second).toBe(first);
    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledTimes(1);

    resolveScan?.(undefined);
    await Promise.all([first, second]);
    expect(mocks.loadSessionRoster).toHaveBeenCalledTimes(1);
  });

  it("allows a new refresh after an in-flight rescan fails", async () => {
    mocks.externalHistoryRescanSources
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(undefined);

    await expect(rescanSidebarSessions()).rejects.toThrow("scan failed");
    await rescanSidebarSessions();

    expect(mocks.externalHistoryRescanSources).toHaveBeenCalledTimes(2);
    expect(mocks.loadSessionRoster).toHaveBeenCalledTimes(1);
  });
});
