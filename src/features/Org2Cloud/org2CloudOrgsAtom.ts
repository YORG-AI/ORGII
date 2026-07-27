/**
 * Cloud orgs the signed-in ORG2 Cloud user belongs to (`list_my_orgs`).
 *
 * ISOLATION (critical): this atom is the ONLY home for managed-cloud orgs.
 * They remain separate from local collaboration records because the two
 * identity namespaces have different ownership and lifecycle rules. Cloud
 * orgs use the managed backend and the CLOUD_ORG panel surface.
 *
 * In-memory only, NOT persisted — refetched on each sign-in / app start via
 * `useOrg2CloudOrgs()` (mounted once in the router root next to
 * `useDeepLinkHandler`). Cleared to `[]` on sign-out. Offline / fetch
 * failure degrades to `[]` (no crash, no stale cache).
 */
import { atom, createStore, useAtom, useStore } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";

import { enrichOrg2CloudProfile } from "./completeSignIn";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { ensureFreshSession, listMyOrgs } from "./org2CloudClient";
import type { CloudEntitlementState } from "./org2CloudClient";
import {
  refreshOrgEntitlement,
  seedOrgEntitlement,
} from "./org2CloudEntitlementCoordinator";

const log = createLogger("Org2CloudOrgs");

/** Seed roster-resolved entitlements; per-org RPC only for unresolved orgs. */
function hydrateOrgEntitlements(
  store: ReturnType<typeof createStore>,
  orgs: readonly Org2CloudOrg[],
  getAccessToken: () => Promise<string | null>
): void {
  const unresolved: Org2CloudOrg[] = [];
  for (const org of orgs) {
    if (org.entitlement) {
      seedOrgEntitlement(store, org.orgId, org.entitlement);
    } else {
      unresolved.push(org);
    }
  }
  if (unresolved.length === 0) return;
  void Promise.all(
    unresolved.map((org) =>
      refreshOrgEntitlement(store, org.orgId, getAccessToken)
    )
  );
}

export interface Org2CloudOrg {
  orgId: string;
  name: string;
  role: string;
  /** Batched entitlement from a 0004 roster listing; absent ⇒ per-org RPC. */
  entitlement?: CloudEntitlementState;
  /** 0007 directory hook; absent ⇒ the org lives on the active endpoint. */
  homeEndpoint?: string;
}

export interface RefetchOrg2CloudOrgsOptions {
  /**
   * Mutation flows know the state their just-committed RPC must expose. When
   * a concurrent Realtime/on-subscribe refresh supersedes that read, retry
   * until the shared atom converges on the mutation's postcondition.
   */
  until?: (orgs: Org2CloudOrg[]) => boolean;
  /** Bounded because an unreachable backend must never leave the UI hanging. */
  maxAttempts?: number;
}

export const org2CloudOrgsAtom = atom<Org2CloudOrg[]>([]);
org2CloudOrgsAtom.debugLabel = "org2CloudOrgsAtom";

/**
 * True once `list_my_orgs` has completed its FIRST SUCCESSFUL load for the
 * current sign-in (even when it returned no orgs). Distinguishes "roster not
 * yet known" (still `[]` at app start, or degraded `[]` after a fetch
 * failure) from an authoritatively empty roster, for membership-gated callers
 * (see `isCloudOrgMembershipPending`). A failed / unreachable fetch leaves it
 * FALSE, so a cloud-aliased work item stays blocked from an unarbitrated
 * start until a real success lands. Reset to `false` on sign-out / endpoint
 * switch, same lifecycle as `org2CloudOrgsAtom`.
 */
export const org2CloudOrgsLoadedAtom = atom<boolean>(false);
org2CloudOrgsLoadedAtom.debugLabel = "org2CloudOrgsLoadedAtom";

/**
 * Monotonic request generation for every `list_my_orgs` caller. Realtime can
 * start a roster read from the membership event before the mutation RPC has
 * committed, while the mutation flow starts a second authoritative read just
 * after commit. Without a shared generation, the older response can finish
 * last and overwrite the joined/deleted roster with stale data.
 */
export const org2CloudOrgsRequestEpochAtom = atom(0);
org2CloudOrgsRequestEpochAtom.debugLabel = "org2CloudOrgsRequestEpochAtom";

type JotaiStore = ReturnType<typeof createStore>;

/**
 * Per-app-store mutation queue. A membership mutation already knows the
 * roster postcondition it must observe; subscription-status and Realtime
 * invalidations must not repeatedly supersede that authoritative read. The
 * queue also gives two overlapping UI mutations a deterministic order.
 */
const org2CloudOrgsConvergenceTail = new WeakMap<JotaiStore, Promise<void>>();
/** Plain Realtime/status refreshes share one request per app store. Mutation
 * convergence remains serialized separately because it carries a postcondition. */
const org2CloudOrgsRefetchInFlight = new WeakMap<
  JotaiStore,
  Promise<Org2CloudOrg[]>
>();

export function isOrg2CloudOrgsConverging(store: JotaiStore): boolean {
  return org2CloudOrgsConvergenceTail.has(store);
}

export async function queueOrg2CloudOrgsConvergence<T>(
  store: JotaiStore,
  operation: () => Promise<T>
): Promise<T> {
  const previous = org2CloudOrgsConvergenceTail.get(store);
  const result = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  org2CloudOrgsConvergenceTail.set(store, tail);
  try {
    return await result;
  } finally {
    if (org2CloudOrgsConvergenceTail.get(store) === tail) {
      org2CloudOrgsConvergenceTail.delete(store);
    }
  }
}

export function beginOrg2CloudOrgsRequest(store: JotaiStore): number {
  const epoch = store.get(org2CloudOrgsRequestEpochAtom) + 1;
  store.set(org2CloudOrgsRequestEpochAtom, epoch);
  return epoch;
}

export function isCurrentOrg2CloudOrgsRequest(
  store: JotaiStore,
  epoch: number
): boolean {
  return store.get(org2CloudOrgsRequestEpochAtom) === epoch;
}

export function commitOrg2CloudOrgsRequest(
  store: JotaiStore,
  epoch: number,
  orgs: Org2CloudOrg[]
): boolean {
  if (!isCurrentOrg2CloudOrgsRequest(store, epoch)) return false;
  store.set(org2CloudOrgsAtom, orgs);
  store.set(org2CloudOrgsLoadedAtom, true);
  return true;
}

/**
 * Per-org roster CHANGE COUNTER, bumped by the Realtime org-wide
 * `org_memberships` subscription (useOrg2CloudRealtime). Consumers that
 * display the member list (CloudOrgPanelView) put their org's counter in a
 * fetch-effect dependency so a teammate joining/leaving/changing role
 * refreshes the list live. Channel-unavailable recovery is driven by focus /
 * visibility events rather than a periodic roster poll.
 */
export const org2CloudRosterVersionAtom = atom<Record<string, number>>({});
org2CloudRosterVersionAtom.debugLabel = "org2CloudRosterVersionAtom";

/** Active orgs whose member-roster Postgres Changes channel is subscribed. */
export const org2CloudRosterRealtimeConnectedAtom = atom<
  Record<string, boolean>
>({});
org2CloudRosterRealtimeConnectedAtom.debugLabel =
  "org2CloudRosterRealtimeConnectedAtom";

/** Cloud org id currently selected in the sidebar workspace scope selector (null = a local scope). */
export const sidebarActiveCloudOrgIdAtom = atom<string | null>(null);
sidebarActiveCloudOrgIdAtom.debugLabel = "sidebarActiveCloudOrgIdAtom";

/** Resolve the exact managed org selected in the sidebar. Local/personal
 * scopes deliberately return null so sharing controls cannot bleed across
 * workspace boundaries. */
export function getSidebarActiveCloudOrg(
  activeOrgId: string | null,
  orgs: Org2CloudOrg[]
): Org2CloudOrg | null {
  if (!activeOrgId) return null;
  return orgs.find((org) => org.orgId === activeOrgId) ?? null;
}

/** Sidebar-selector value namespace so cloud org ids can never collide with
 * self-hosted org ids or the personal-org sentinel. */
export const CLOUD_ORG_SELECTOR_PREFIX = "cloud:";

export function buildCloudOrgSelectorValue(orgId: string): string {
  return `${CLOUD_ORG_SELECTOR_PREFIX}${orgId}`;
}

export function parseCloudOrgSelectorValue(value: string): string | null {
  return value.startsWith(CLOUD_ORG_SELECTOR_PREFIX)
    ? value.slice(CLOUD_ORG_SELECTOR_PREFIX.length)
    : null;
}

/**
 * Populate `org2CloudOrgsAtom` whenever a cloud user is signed in; clear it
 * on sign-out. Keyed on endpoint + `userId` (not the whole auth object) so a
 * token-refresh write does not retrigger the fetch while an endpoint/account
 * switch can never retain the previous deployment's roster.
 */
export function useOrg2CloudOrgs(): void {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const store = useStore();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;

  useLayoutEffect(() => {
    // Identity changes are a hard visibility boundary. Clear the prior
    // deployment/account roster before paint; otherwise the selector and
    // Realtime manager can briefly treat old org ids as belonging to the new
    // account while the first token refresh/list request is pending.
    beginOrg2CloudOrgsRequest(store);
    store.set(org2CloudOrgsAtom, []);
    store.set(org2CloudOrgsLoadedAtom, false);
  }, [authIdentityKey, store]);

  useEffect(() => {
    if (!authIdentityKey) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Bounded auto-retry with backoff. A TRANSIENT token-refresh /
    // list_my_orgs failure otherwise degrades the roster to `[]` with the
    // loaded flag stuck FALSE — cloud orgs SILENTLY vanish from the org
    // selector AND the sidebar "Team sessions" section (they fall back to
    // plain local-alias entries, no cloud badge), and stay gone until the
    // NEXT sign-in / app start. Retrying lets a blip self-heal on its own.
    // An explicitly rejected refresh credential signs out immediately;
    // transient transport/server failures remain degraded and retry here.
    const RETRY_DELAYS_MS = [2000, 5000, 10000, 20000];
    const runAttempt = async (attempt: number): Promise<void> => {
      const current = authRef.current;
      if (!current || cancelled) return;
      const requestEpoch = beginOrg2CloudOrgsRequest(store);
      const retry = (): void => {
        if (cancelled || attempt >= RETRY_DELAYS_MS.length) return;
        retryTimer = setTimeout(() => {
          void runAttempt(attempt + 1);
        }, RETRY_DELAYS_MS[attempt]);
      };
      let refreshRejected = false;
      const fresh = await ensureFreshSession(current, {
        onRefreshRejected: () => {
          refreshRejected = true;
          // Compare-and-set: never sign out a newer OAuth callback or a
          // concurrently refreshed token chain because an older request
          // finished late.
          setAuth((latest) => (latest === current ? null : latest));
        },
      });
      if (cancelled || !isCurrentOrg2CloudOrgsRequest(store, requestEpoch)) {
        return;
      }
      if (!fresh) {
        log.warn("cloud org fetch skipped: token refresh failed");
        if (!refreshRejected) retry();
        return;
      }
      commitRefreshedAuth(setAuth, current, fresh);
      // Self-heal a missing display profile: sign-in enrichment is a one-shot
      // fire-and-forget (completeSignIn), so if it failed — RPC blip, or the
      // profiles row didn't exist yet (e.g. right after a backend reset) —
      // the Settings surface shows the raw user id until the NEXT sign-in.
      // Retrying on each app start bounds that to one launch.
      if (!current.profile) {
        void enrichOrg2CloudProfile(fresh, setAuth);
      }
      const orgs = await listMyOrgs(fresh.accessToken);
      if (cancelled || !isCurrentOrg2CloudOrgsRequest(store, requestEpoch)) {
        return;
      }
      if (orgs === null) {
        // Unreachable roster (offline / flaky): keep the degraded-but-safe
        // `[]` with loaded FALSE (a cloud-aliased work item stays
        // membership-pending — blocked from an unarbitrated start), and
        // retry so it recovers without waiting for the next sign-in.
        store.set(org2CloudOrgsAtom, []);
        retry();
        return;
      }
      if (!commitOrg2CloudOrgsRequest(store, requestEpoch, orgs)) return;
      // Best-effort: hydrate the admin sharing-FLOOR mirror (0002) for each
      // org so the per-session sync dialog — opened straight from the session
      // context menu, without ever visiting the org panel — can gate its
      // options against the floor. A 0004 backend already resolved each
      // org's entitlement inside the roster round-trip — seed those straight
      // into the coordinator; only orgs the listing could not resolve fall
      // back to the per-org RPC. Non-blocking; per-org failures (null) just
      // leave that org's persisted mirror untouched (server still enforces).
      hydrateOrgEntitlements(store, orgs, async () => fresh.accessToken);
    };
    void runAttempt(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [authIdentityKey, setAuth, store]);
}

/**
 * Imperative refetch of `list_my_orgs` for org-management flows (create /
 * join / rename / transfer / leave / delete must be reflected in the
 * selector immediately, not on the next sign-in). Returns the fresh list
 * (also written to the atom) so callers can look up the org they just
 * joined; `[]` when signed out or the refresh fails — same degradation as
 * `useOrg2CloudOrgs`.
 */
export function useRefetchOrg2CloudOrgs(): (
  options?: RefetchOrg2CloudOrgsOptions
) => Promise<Org2CloudOrg[]> {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const store = useStore();
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(
    async (options?: RefetchOrg2CloudOrgsOptions) => {
      const run = async (): Promise<Org2CloudOrg[]> => {
        const maxAttempts = options?.until
          ? Math.max(1, options.maxAttempts ?? 4)
          : 1;
        let latest = store.get(org2CloudOrgsAtom);

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
          const current = authRef.current;
          const requestEpoch = beginOrg2CloudOrgsRequest(store);
          if (!current) {
            store.set(org2CloudOrgsAtom, []);
            store.set(org2CloudOrgsLoadedAtom, false);
            return [];
          }
          const fresh = await ensureFreshSession(current);
          if (!isCurrentOrg2CloudOrgsRequest(store, requestEpoch)) {
            latest = store.get(org2CloudOrgsAtom);
          } else if (!fresh) {
            log.warn("cloud org refetch skipped: token refresh failed");
            latest = [];
          } else {
            commitRefreshedAuth(setAuth, current, fresh);
            const orgs = await listMyOrgs(fresh.accessToken);
            if (!isCurrentOrg2CloudOrgsRequest(store, requestEpoch)) {
              latest = store.get(org2CloudOrgsAtom);
            } else if (orgs === null) {
              latest = [];
            } else if (commitOrg2CloudOrgsRequest(store, requestEpoch, orgs)) {
              latest = orgs;
              // Entitlement hydration is enrichment, not part of roster
              // convergence. Batched 0004 payloads seed the coordinator
              // directly; only unresolved orgs read through the per-org RPC.
              hydrateOrgEntitlements(
                store,
                orgs,
                async () => fresh.accessToken
              );
            } else {
              latest = store.get(org2CloudOrgsAtom);
            }
          }

          if (!options?.until || options.until(latest)) return latest;
        }
        return latest;
      };

      if (!options?.until) {
        // Mutation convergence owns the next authoritative generation. A
        // Realtime signal arriving inside that tiny window is already covered
        // by the mutation's postcondition and must not starve it.
        if (isOrg2CloudOrgsConverging(store)) {
          return store.get(org2CloudOrgsAtom);
        }
        const active = org2CloudOrgsRefetchInFlight.get(store);
        if (active) return active;
        const request = run();
        org2CloudOrgsRefetchInFlight.set(store, request);
        try {
          return await request;
        } finally {
          if (org2CloudOrgsRefetchInFlight.get(store) === request) {
            org2CloudOrgsRefetchInFlight.delete(store);
          }
        }
      }
      return queueOrg2CloudOrgsConvergence(store, run);
    },
    [setAuth, store]
  );
}
