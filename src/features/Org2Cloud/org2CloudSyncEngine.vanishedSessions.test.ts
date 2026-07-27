import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { Org2CloudSessionSyncState } from "./org2CloudSessionSync.state";
import type { CollabSessionPushCursor } from "./org2CloudSyncAtoms";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
} from "./org2CloudSyncAtoms";
import { findVanishedPushedSessionIds } from "./org2CloudSyncEngine.vanishedSessions";

function cursor(orgId: string, sessionId: string): CollabSessionPushCursor {
  return {
    orgId,
    sessionId,
    epoch: 1,
    frozenSeq: 0,
    pushedCount: 0,
    frozenEventCount: 0,
    frozenChainHash: "",
    tailHash: null,
  };
}

describe("findVanishedPushedSessionIds", () => {
  it("returns only marked ids that neither the roster nor the backend resolve", async () => {
    const resolveSessionIds = vi
      .fn()
      .mockResolvedValue(new Set(["paginated-out"]));

    const vanished = await findVanishedPushedSessionIds({
      orgId: "corg-1",
      markedSessionIds: new Set(["in-roster", "paginated-out", "ghost"]),
      liveSessionIds: new Set(["in-roster"]),
      resolveSessionIds,
    });

    // Roster hits are never even sent to the backend; a marked id the
    // backend still resolves (merely outside the loaded pages) is kept.
    expect(resolveSessionIds).toHaveBeenCalledTimes(1);
    expect(resolveSessionIds).toHaveBeenCalledWith(["paginated-out", "ghost"]);
    expect(vanished).toEqual(["ghost"]);
  });

  it("skips the backend lookup entirely when every marked id is in the roster", async () => {
    const resolveSessionIds = vi.fn();

    const vanished = await findVanishedPushedSessionIds({
      orgId: "corg-1",
      markedSessionIds: new Set(["a", "b"]),
      liveSessionIds: new Set(["a", "b", "c"]),
      resolveSessionIds,
    });

    expect(vanished).toEqual([]);
    expect(resolveSessionIds).not.toHaveBeenCalled();
  });

  it("treats a failed lookup as unknown and retracts nothing", async () => {
    const resolveSessionIds = vi
      .fn()
      .mockRejectedValue(new Error("backend offline"));

    const vanished = await findVanishedPushedSessionIds({
      orgId: "corg-1",
      markedSessionIds: new Set(["ghost"]),
      liveSessionIds: new Set(),
      resolveSessionIds,
    });

    expect(vanished).toEqual([]);
  });
});

describe("Org2CloudSessionSyncState.markedSessionIds", () => {
  it("unions metadata markers and cursors for exactly the requested org", () => {
    const store = createStore();
    store.set(org2CloudPushedMetadataAtom, {
      "corg-1:meta-only": true,
      "corg-1:both": true,
      "corg-2:other-org": true,
    });
    store.set(org2CloudPushCursorsAtom, {
      "corg-1:both": cursor("corg-1", "both"),
      "corg-1:cursor-only": cursor("corg-1", "cursor-only"),
      "corg-2:other-org": cursor("corg-2", "other-org"),
    });
    const state = new Org2CloudSessionSyncState(() => store);

    expect([...state.markedSessionIds("corg-1")].sort()).toEqual([
      "both",
      "cursor-only",
      "meta-only",
    ]);
    expect([...state.markedSessionIds("corg-2")]).toEqual(["other-org"]);
    expect(state.markedSessionIds("corg-3").size).toBe(0);
  });

  it("keeps composite session ids containing colons intact", () => {
    const store = createStore();
    store.set(org2CloudPushedMetadataAtom, {
      "corg-1:weird:session:id": true,
    });
    const state = new Org2CloudSessionSyncState(() => store);

    expect([...state.markedSessionIds("corg-1")]).toEqual(["weird:session:id"]);
  });
});
