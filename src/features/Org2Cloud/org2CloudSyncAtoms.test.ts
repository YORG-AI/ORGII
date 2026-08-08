import { describe, expect, it, vi } from "vitest";

import { CloudPushCursorsSchema } from "./org2CloudSyncAtoms";

const VALID_CURSOR = {
  orgId: "org-1",
  sessionId: "session-1",
  epoch: 1,
  frozenSeq: 2,
  pushedCount: 6,
  frozenEventCount: 6,
  frozenChainHash: "hash",
  tailHash: null,
  importedReplay: {
    version: 1,
    reloadTurnId: "turn-b",
    prefixTurnIdsHash: "prefix-hash",
    retainedEventCount: 4,
    retainedChunkCount: 4,
    frozenOverlapCount: 2,
    frozenOverlapHash: "overlap-hash",
    frozenHashFrontier: [null, "node-a", "node-b"],
  },
};

describe("CloudPushCursorsSchema", () => {
  it("drops only the malformed entries, never the whole store", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // One healthy cursor beside every rollback/corruption shape the store
    // can meet: a future checkpoint version, an oversized frontier, and a
    // non-object entry. A whole-store reset here would re-anchor EVERY
    // pushed session through an epoch rewrite; dropping one entry costs
    // exactly one session's re-anchor.
    const parsed = CloudPushCursorsSchema.parse({
      "org-1:session-1": VALID_CURSOR,
      "org-1:future-version": {
        ...VALID_CURSOR,
        importedReplay: { ...VALID_CURSOR.importedReplay, version: 2 },
      },
      "org-1:oversized-frontier": {
        ...VALID_CURSOR,
        importedReplay: {
          ...VALID_CURSOR.importedReplay,
          frozenHashFrontier: Array.from({ length: 55 }, () => null),
        },
      },
      "org-1:not-a-cursor": "garbage",
    });
    expect(Object.keys(parsed)).toEqual(["org-1:session-1"]);
    expect(parsed["org-1:session-1"]).toEqual(VALID_CURSOR);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("keeps flat cursors without a checkpoint untouched", () => {
    const { importedReplay: _checkpoint, ...flat } = VALID_CURSOR;
    const parsed = CloudPushCursorsSchema.parse({ "org-1:flat": flat });
    expect(parsed["org-1:flat"]).toEqual(flat);
    expect(parsed["org-1:flat"].importedReplay).toBeUndefined();
  });

  it("parses an empty store to an empty record", () => {
    expect(CloudPushCursorsSchema.parse({})).toEqual({});
  });
});
