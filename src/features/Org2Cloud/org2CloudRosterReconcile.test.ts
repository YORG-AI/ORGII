import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
} from "./org2CloudAccessSettings";
import {
  orgIdOfCompositeKey,
  pruneOrgKeyedRecord,
  reconcileOrg2CloudPersistedState,
  rosterReconcileKey,
  shouldReconcileRoster,
} from "./org2CloudRosterReconcile";
import {
  type CollabSessionPushCursor,
  org2CloudCollabStateCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";

const LIVE = "e0e22b9d-b596-48a2-94d7-0f354fa3318b";
const ZOMBIE = "838c1a41-0000-0000-0000-000000000000";

function makeCursor(orgId: string): CollabSessionPushCursor {
  return {
    orgId,
    sessionId: "s1",
    epoch: 1,
    frozenSeq: 0,
    pushedCount: 1,
    frozenEventCount: 0,
    frozenChainHash: "h",
    tailHash: null,
  };
}

describe("pruneOrgKeyedRecord", () => {
  it("prunes zombie keys and keeps live ones", () => {
    const { next, prunedOrgIds } = pruneOrgKeyedRecord(
      { [LIVE]: ["a"], [ZOMBIE]: ["b"] },
      new Set([LIVE])
    );
    expect(next).toEqual({ [LIVE]: ["a"] });
    expect(prunedOrgIds).toEqual([ZOMBIE]);
  });

  it("extracts the org id from composite pushCursor keys", () => {
    expect(orgIdOfCompositeKey(`${ZOMBIE}:session-1`)).toBe(ZOMBIE);
    expect(orgIdOfCompositeKey("plain-key")).toBe("plain-key");
  });
});

describe("shouldReconcileRoster", () => {
  it("never prunes before the roster's first successful load", () => {
    expect(shouldReconcileRoster(false, 0)).toBe(false);
    expect(shouldReconcileRoster(false, 3)).toBe(false);
  });

  it("prunes on an authoritatively empty roster", () => {
    expect(shouldReconcileRoster(true, 0)).toBe(true);
  });

  it("prunes when loaded with a non-empty roster", () => {
    expect(shouldReconcileRoster(true, 1)).toBe(true);
  });
});

describe("rosterReconcileKey", () => {
  it("changes when membership changes under the same identity", () => {
    const first = rosterReconcileKey("cloud|user-1", true, [LIVE, ZOMBIE]);
    const afterLeave = rosterReconcileKey("cloud|user-1", true, [LIVE]);

    expect(first).not.toBe(afterLeave);
  });

  it("is stable across roster order and duplicate rows", () => {
    expect(rosterReconcileKey("cloud|user-1", true, [ZOMBIE, LIVE, LIVE])).toBe(
      rosterReconcileKey("cloud|user-1", true, [LIVE, ZOMBIE])
    );
  });

  it("does not authorize pruning before a successful load", () => {
    expect(rosterReconcileKey("cloud|user-1", false, [LIVE])).toBeNull();
  });
});

describe("reconcileOrg2CloudPersistedState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("prunes zombie org entries from backend-coupled maps, keeping live ones", () => {
    const store = createStore();
    store.set(org2CloudRepoScopesAtom, {
      [LIVE]: ["github.com/a/b"],
      [ZOMBIE]: ["github.com/c/d"],
    });
    store.set(org2CloudSyncEnabledAtom, { [LIVE]: true, [ZOMBIE]: false });
    store.set(org2CloudPushCursorsAtom, {
      [`${LIVE}:s1`]: makeCursor(LIVE),
      [`${ZOMBIE}:s1`]: makeCursor(ZOMBIE),
    });
    store.set(org2CloudPushedMetadataAtom, {
      [`${LIVE}:s2`]: true,
      [`${ZOMBIE}:s2`]: true,
    });
    store.set(org2CloudCollabStateCursorsAtom, {
      [LIVE]: "2026-07-01T00:00:00Z",
      [ZOMBIE]: "2026-01-01T00:00:00Z",
    });

    const pruned = reconcileOrg2CloudPersistedState(store, new Set([LIVE]));

    expect(pruned).toEqual([ZOMBIE]);
    expect(store.get(org2CloudRepoScopesAtom)).toEqual({
      [LIVE]: ["github.com/a/b"],
    });
    expect(store.get(org2CloudSyncEnabledAtom)).toEqual({ [LIVE]: true });
    expect(Object.keys(store.get(org2CloudPushCursorsAtom))).toEqual([
      `${LIVE}:s1`,
    ]);
    expect(Object.keys(store.get(org2CloudPushedMetadataAtom))).toEqual([
      `${LIVE}:s2`,
    ]);
    expect(store.get(org2CloudCollabStateCursorsAtom)).toEqual({
      [LIVE]: "2026-07-01T00:00:00Z",
    });
  });

  it("preserves the ratchet atoms endpoint-switch keeps, even for orgs absent from the current roster", () => {
    const store = createStore();
    store.set(org2CloudAccessSettingsAtom, {
      [LIVE]: {
        sessionModes: {},
        sessionVisibility: {},
      },
      [ZOMBIE]: {
        sessionModes: {},
        sessionVisibility: {},
      },
    });
    store.set(org2CloudSharingFloorAtom, {
      [LIVE]: "off",
      [ZOMBIE]: "metadata_only",
    });

    const pruned = reconcileOrg2CloudPersistedState(store, new Set([LIVE]));

    expect(pruned).toEqual([]);
    expect(Object.keys(store.get(org2CloudAccessSettingsAtom)).sort()).toEqual(
      [LIVE, ZOMBIE].sort()
    );
    expect(store.get(org2CloudAccessSettingsAtom)[ZOMBIE]).toEqual({
      sessionModes: {},
      sessionVisibility: {},
    });
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({
      [LIVE]: "off",
      [ZOMBIE]: "metadata_only",
    });
  });

  it("is a no-op when every persisted org is live", () => {
    const store = createStore();
    store.set(org2CloudRepoScopesAtom, { [LIVE]: ["github.com/a/b"] });

    const pruned = reconcileOrg2CloudPersistedState(store, new Set([LIVE]));

    expect(pruned).toEqual([]);
    expect(store.get(org2CloudRepoScopesAtom)).toEqual({
      [LIVE]: ["github.com/a/b"],
    });
  });
});
