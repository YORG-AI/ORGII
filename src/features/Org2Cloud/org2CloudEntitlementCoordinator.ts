/**
 * THE per-org sharing-floor reader (audit 2026-07-18, "one coordinator").
 *
 * Roster bootstrap/refetch and the Realtime change-signal handler previously
 * each owned an entitlement read path with different freshness rules — one
 * unbounded Promise.all per roster load, one hook-local TTL map. Both wrote
 * the same persisted floor mirror, so reconnect could overlap two readers.
 * Every caller now goes through this store-keyed single-flight + TTL gate;
 * no caller keeps its own cache.
 *
 * Writes are per-org and single-flight, so a floor value can never land out
 * of order for one org — the old cross-hydration stamp is unnecessary.
 */
import type { createStore } from "jotai";

import { createLogger } from "@src/hooks/logger";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { org2CloudSharingFloorAtom } from "./org2CloudAccessSettings";
import type { CloudEntitlementState } from "./org2CloudClient";
import { getEntitlementState } from "./org2CloudClient";

const log = createLogger("Org2CloudEntitlement");

type JotaiStore = ReturnType<typeof createStore>;

/**
 * Short on purpose: a burst of explicit floor-change broadcasts and
 * reconnect recovery must still collapse to one request. Generic session /
 * project / comment signals no longer enter this coordinator.
 */
export const ENTITLEMENT_REFRESH_TTL_MS = 10_000;

interface OrgEntitlementEntry {
  lastAttemptAt: number;
  inFlight: Promise<void> | null;
  trailingTimer: ReturnType<typeof setTimeout> | null;
}

const entriesByStore = new WeakMap<
  JotaiStore,
  Map<string, OrgEntitlementEntry>
>();
const epochByStore = new WeakMap<JotaiStore, number>();

function currentEpoch(store: JotaiStore): number {
  return epochByStore.get(store) ?? 0;
}

function entryFor(store: JotaiStore, orgId: string): OrgEntitlementEntry {
  let entries = entriesByStore.get(store);
  if (!entries) {
    entries = new Map();
    entriesByStore.set(store, entries);
  }
  let entry = entries.get(orgId);
  if (!entry) {
    entry = { lastAttemptAt: 0, inFlight: null, trailingTimer: null };
    entries.set(orgId, entry);
  }
  return entry;
}

/**
 * Commit an entitlement snapshot the ROSTER LISTING already resolved (0004
 * backends return one per org row). This is an authoritative read for TTL
 * purposes: stamping the window keeps a same-moment signal burst from
 * re-reading what the roster round-trip just delivered. Backends without the
 * batched key keep using `refreshOrgEntitlement` per org.
 */
export function seedOrgEntitlement(
  store: JotaiStore,
  orgId: string,
  entitlement: CloudEntitlementState
): void {
  const entry = entryFor(store, orgId);
  entry.lastAttemptAt = Date.now();
  const floor = entitlement.orgSharingFloor ?? COLLAB_SESSION_ACCESS_MODE.OFF;
  store.set(org2CloudSharingFloorAtom, (previous) =>
    previous[orgId] === floor ? previous : { ...previous, [orgId]: floor }
  );
}

/**
 * Refresh one org's sharing floor into the persisted mirror. Coalesces into
 * an in-flight read; skips inside the TTL unless `force`. `getAccessToken`
 * is called only when a real read happens (callers keep their own token
 * refresh semantics).
 */
export async function refreshOrgEntitlement(
  store: JotaiStore,
  orgId: string,
  getAccessToken: () => Promise<string | null>,
  options: { force?: boolean; isRetry?: boolean } = {}
): Promise<void> {
  const epoch = currentEpoch(store);
  const entry = entryFor(store, orgId);
  if (entry.inFlight) return entry.inFlight;
  const now = Date.now();
  if (
    !options.force &&
    now - entry.lastAttemptAt < ENTITLEMENT_REFRESH_TTL_MS
  ) {
    // Trailing edge: a gated signal must not be DROPPED — the change it
    // announced (e.g. an admin floor flip) may be the last signal for a
    // long time. Coalesce into one deferred refresh at window expiry.
    if (!entry.trailingTimer) {
      const delay = ENTITLEMENT_REFRESH_TTL_MS - (now - entry.lastAttemptAt);
      entry.trailingTimer = setTimeout(() => {
        entry.trailingTimer = null;
        if (currentEpoch(store) !== epoch) return;
        void refreshOrgEntitlement(store, orgId, getAccessToken);
      }, delay);
    }
    return;
  }
  if (entry.trailingTimer) {
    clearTimeout(entry.trailingTimer);
    entry.trailingTimer = null;
  }
  entry.lastAttemptAt = now;
  const scheduleRetry = () => {
    if (
      currentEpoch(store) !== epoch ||
      entry.trailingTimer ||
      options.isRetry
    ) {
      return;
    }
    entry.trailingTimer = setTimeout(() => {
      entry.trailingTimer = null;
      if (currentEpoch(store) !== epoch) return;
      void refreshOrgEntitlement(store, orgId, getAccessToken, {
        isRetry: true,
      });
    }, ENTITLEMENT_REFRESH_TTL_MS);
  };
  const flight = (async () => {
    try {
      const accessToken = await getAccessToken();
      if (!accessToken || currentEpoch(store) !== epoch) return;
      const entitlement = await getEntitlementState(accessToken, orgId);
      if (currentEpoch(store) !== epoch) return;
      if (!entitlement) {
        // Transient read failure: the signal that triggered this refresh
        // may have been the floor change's only nudge — retry once after
        // the window instead of silently keeping the stale mirror.
        scheduleRetry();
        return;
      }
      const floor =
        entitlement.orgSharingFloor ?? COLLAB_SESSION_ACCESS_MODE.OFF;
      store.set(org2CloudSharingFloorAtom, (previous) =>
        previous[orgId] === floor ? previous : { ...previous, [orgId]: floor }
      );
    } catch (error) {
      log.warn(`entitlement refresh failed for org ${orgId}:`, error);
    }
  })();
  entry.inFlight = flight;
  try {
    await flight;
  } finally {
    entry.inFlight = null;
  }
}

/**
 * Invalidate every in-flight/deferred read for a signed-out, switched-user or
 * switched-endpoint store. Late promises remain harmless because their epoch
 * can no longer commit into the new identity's UI state.
 */
export function resetOrgEntitlementCoordinator(store: JotaiStore): void {
  const entries = entriesByStore.get(store);
  if (entries) {
    for (const entry of entries.values()) {
      if (entry.trailingTimer) clearTimeout(entry.trailingTimer);
      entry.trailingTimer = null;
    }
  }
  entriesByStore.delete(store);
  epochByStore.set(store, currentEpoch(store) + 1);
}

export const __ENTITLEMENT_COORDINATOR_INTERNALS = {
  resetForStore: resetOrgEntitlementCoordinator,
};
