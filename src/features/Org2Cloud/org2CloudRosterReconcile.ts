/**
 * Roster reconciliation sweep: after every authoritative `list_my_orgs`
 * membership-set change, prune entries keyed by cloud org ids
 * that are no longer in the roster from the BACKEND-COUPLED
 * `orgii:org2-cloud-v1:*` persisted per-org maps. A wiped/rebuilt managed
 * backend otherwise leaves zombie org ids in these caches forever (there is
 * no other GC path).
 *
 * Prune-set MUST equal `resetCloudStateForEndpointSwitch`'s wipe-set. The
 * ratchet atoms that endpoint-switch DELIBERATELY preserves
 * (`org2CloudAccessSettingsAtom`, `org2CloudSharingFloorAtom`) are excluded
 * here too: they describe the
 * OTHER endpoint's orgs across a switch, so pruning them by the current
 * roster would silently drop the privacy ladder / runner intent the switch
 * kept. Org ids are uuids, so a genuinely-dead entry never collides.
 *
 * Conservative by design: runs only when the roster loaded successfully. An
 * authoritatively empty roster is still a valid result and must prune the
 * previous account's backend-owned state; a transient failure keeps the
 * loaded flag FALSE and never prunes.
 */
import { type WritableAtom, createStore, useAtomValue, useStore } from "jotai";
import { useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "./org2CloudOrgsAtom";
import {
  org2CloudCollabStateCursorsAtom,
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "./org2CloudSyncAtoms";

const log = createLogger("Org2CloudRosterReconcile");

type JotaiStore = ReturnType<typeof createStore>;

export function pruneOrgKeyedRecord<R extends Record<string, unknown>>(
  record: R,
  liveOrgIds: ReadonlySet<string>,
  orgIdOfKey: (key: string) => string = (key) => key
): { next: R; prunedOrgIds: string[] } {
  const pruned = new Set<string>();
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const orgId = orgIdOfKey(key);
    if (liveOrgIds.has(orgId)) {
      next[key] = value;
    } else {
      pruned.add(orgId);
    }
  }
  return { next: next as R, prunedOrgIds: [...pruned] };
}

/** `${orgId}:${sessionId}` composite keys (cloud org ids contain no colon). */
export function orgIdOfCompositeKey(key: string): string {
  const separatorIndex = key.indexOf(":");
  return separatorIndex === -1 ? key : key.slice(0, separatorIndex);
}

function sweepAtom<R extends Record<string, unknown>>(
  store: JotaiStore,
  mapName: string,
  target: WritableAtom<R, [R], unknown>,
  liveOrgIds: ReadonlySet<string>,
  prunedByOrg: Map<string, string[]>,
  orgIdOfKey?: (key: string) => string
): void {
  const { next, prunedOrgIds } = pruneOrgKeyedRecord(
    store.get(target),
    liveOrgIds,
    orgIdOfKey
  );
  if (prunedOrgIds.length === 0) return;
  store.set(target, next);
  for (const orgId of prunedOrgIds) {
    prunedByOrg.set(orgId, [...(prunedByOrg.get(orgId) ?? []), mapName]);
  }
}

/** Returns the pruned (dead) org ids; logs one line per pruned org. */
export function reconcileOrg2CloudPersistedState(
  store: JotaiStore,
  liveOrgIds: ReadonlySet<string>
): string[] {
  const prunedByOrg = new Map<string, string[]>();
  sweepAtom(
    store,
    "repoScopes",
    org2CloudRepoScopesAtom,
    liveOrgIds,
    prunedByOrg
  );
  sweepAtom(
    store,
    "syncEnabled",
    org2CloudSyncEnabledAtom,
    liveOrgIds,
    prunedByOrg
  );
  sweepAtom(
    store,
    "pushCursors",
    org2CloudPushCursorsAtom,
    liveOrgIds,
    prunedByOrg,
    orgIdOfCompositeKey
  );
  sweepAtom(
    store,
    "pushedMetadata",
    org2CloudPushedMetadataAtom,
    liveOrgIds,
    prunedByOrg,
    orgIdOfCompositeKey
  );
  sweepAtom(
    store,
    "collabStateCursors",
    org2CloudCollabStateCursorsAtom,
    liveOrgIds,
    prunedByOrg
  );
  for (const [orgId, mapNames] of prunedByOrg) {
    log.info(
      `pruned dead cloud org ${orgId} from persisted maps: ${mapNames.join(", ")}`
    );
  }
  return [...prunedByOrg.keys()];
}

export function shouldReconcileRoster(
  loaded: boolean,
  _orgCount: number
): boolean {
  return loaded;
}

/** Stable effect key: role/name/order-only roster changes do not need a GC
 * sweep, while a join/leave/delete under the same identity always does. */
export function rosterReconcileKey(
  authIdentityKey: string | null,
  loaded: boolean,
  orgIds: readonly string[]
): string | null {
  if (!authIdentityKey || !shouldReconcileRoster(loaded, orgIds.length)) {
    return null;
  }
  return JSON.stringify([authIdentityKey, [...new Set(orgIds)].sort()]);
}

export function useOrg2CloudRosterReconcile(): void {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const loaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const reconciledRosterRef = useRef<string | null>(null);
  const reconcileKey = rosterReconcileKey(
    authIdentityKey,
    loaded,
    orgs.map((org) => org.orgId)
  );

  useEffect(() => {
    if (!reconcileKey) {
      if (!authIdentityKey) reconciledRosterRef.current = null;
      return;
    }
    if (reconciledRosterRef.current === reconcileKey) return;
    reconciledRosterRef.current = reconcileKey;
    reconcileOrg2CloudPersistedState(
      store,
      new Set(orgs.map((org) => org.orgId))
    );
  }, [authIdentityKey, orgs, reconcileKey, store]);
}
