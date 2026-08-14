import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  type CloudPausedDownload,
  clearCloudDownloadPendingPlayAtom,
  clearCloudPausedDownloadAtom,
  cloudDownloadPendingPlayAtom,
  cloudDownloadStartRequestAtom,
  cloudSessionPausedDownloadsAtom,
  setCloudDownloadPendingPlayAtom,
  setCloudPausedDownloadAtom,
} from "./cloudSessionDownloadControlAtoms";

const PAUSED: CloudPausedDownload = {
  localSessionId: "imported-session-abc",
  orgId: "org-1",
  totalEvents: 4450,
  loadedEvents: 1200,
  cursor: { epoch: 3, seq: 18, count: 1200, frozenCount: 1180 },
};

describe("cloud download control atoms", () => {
  it("holds and clears paused downloads per row", () => {
    const store = createStore();
    store.set(setCloudPausedDownloadAtom, { rowId: "row-1", entry: PAUSED });
    expect(store.get(cloudSessionPausedDownloadsAtom).get("row-1")).toEqual(
      PAUSED
    );

    store.set(clearCloudPausedDownloadAtom, "row-1");
    expect(store.get(cloudSessionPausedDownloadsAtom).size).toBe(0);
  });

  it("clearing an absent paused row keeps the map identity stable", () => {
    const store = createStore();
    const before = store.get(cloudSessionPausedDownloadsAtom);
    store.set(clearCloudPausedDownloadAtom, "missing");
    expect(store.get(cloudSessionPausedDownloadsAtom)).toBe(before);
  });

  it("parks and clears pending-play entries per local session", () => {
    const store = createStore();
    store.set(setCloudDownloadPendingPlayAtom, {
      localSessionId: "imported-session-abc",
      entry: {
        rowId: "row-1",
        orgId: "org-1",
        iconId: "codex",
        pendingEvents: 4450,
        etaMs: 17_000,
        kind: "replay",
      },
    });
    expect(
      store.get(cloudDownloadPendingPlayAtom).get("imported-session-abc")
    ).toMatchObject({ pendingEvents: 4450, iconId: "codex" });

    store.set(clearCloudDownloadPendingPlayAtom, "imported-session-abc");
    expect(store.get(cloudDownloadPendingPlayAtom).size).toBe(0);
  });

  it("start requests are single-slot", () => {
    const store = createStore();
    store.set(cloudDownloadStartRequestAtom, {
      requestId: 1,
      rowId: "row-1",
      orgId: "org-1",
      kind: "replay",
    });
    store.set(cloudDownloadStartRequestAtom, {
      requestId: 2,
      rowId: "row-2",
      orgId: "org-1",
      kind: "fork",
    });
    expect(store.get(cloudDownloadStartRequestAtom)?.rowId).toBe("row-2");
  });
});
