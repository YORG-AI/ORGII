/**
 * ORG2 Cloud inbound-sync Realtime manager (design: cloud-sync-supabase-realtime).
 *
 * Replaces 60s polling as the PRIMARY inbound trigger with Supabase Postgres
 * Changes. Mounted once in the router root beside `useOrg2CloudOrgs` /
 * `useOrg2CloudSyncEngine`. Owns one Realtime connection per signed-in
 * session/endpoint/org-roster generation and drives two inbound slices:
 *
 *  - Slice A (roster):   subscribe `org_memberships` filtered to the current
 *                        user; any change → `refetchOrgs()` (`list_my_orgs`),
 *                        the single source of truth. Catches admin/foreign
 *                        org-delete and remove-member without a re-login.
 *  - Slice B (signals):  per-org subscribe `org_change_signals` — a tiny
 *                        member-readable table that server-side triggers
 *                        touch on EVERY cloud_projects / cloud_work_items /
 *                        cloud_session_comments change (the data tables stay
 *                        RPC-only). Any signal →
 *                        `engine.invalidateOrgInbound(orgId)` (reuses the
 *                        existing collab-state pull + cursor/LWW/apply).
 *
 * Realtime is an INVALIDATION signal only: the data still arrives through the
 * existing RPC pull paths, so no cursor/tombstone logic is duplicated here. The
 * sync engine keeps a low-frequency fallback pass (see org2CloudSyncEngine) so
 * a dropped socket still reaches eventual consistency.
 *
 * On (re)subscribe the true-edge of `onStatus` forces a compensating full pull
 * (roster refetch for A; `invalidateOrgInbound` for B) to recover any events
 * missed while disconnected.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  cloudOrgIdsForSession,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";

import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import {
  COMMENTS_CHANGED_EVENT,
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
  registerCommentsBroadcaster,
  sessionCommentsKey,
} from "./org2CloudCommentsBus";
import { refreshOrgEntitlement } from "./org2CloudEntitlementCoordinator";
import {
  org2CloudOrgsAtom,
  org2CloudRosterVersionAtom,
  sidebarActiveCloudOrgIdAtom,
  useRefetchOrg2CloudOrgs,
} from "./org2CloudOrgsAtom";
import {
  type Org2CloudPresenceEntry,
  latestPresenceMeta,
  org2CloudPresenceAtom,
  org2CloudPresenceOutboundAtom,
  resolveCloudSessionRefs,
} from "./org2CloudPresenceAtom";
import {
  type Org2CloudPresenceHandle,
  type Org2CloudRealtimeConnection,
  createOrg2CloudRealtimeConnection,
} from "./org2CloudRealtimeClient";
import {
  org2CloudRemoteSessionsAtom,
  org2CloudRemoteSessionsVersionAtom,
} from "./org2CloudRemoteSessionsAtom";
import { org2CloudSyncEngine } from "./org2CloudSyncEngine";

const log = createLogger("Org2CloudRealtime");

/**
 * Per-org change-signal table (schema `org2_cloud`) for Slice B:
 * `org_change_signals`, defined in the consolidated baseline with
 * `REPLICA IDENTITY FULL`, membership in `supabase_realtime`, and an
 * `is_org_member(org_id)` SELECT policy — the row-level authorization
 * Realtime needs. Server triggers bump one row per org on every
 * projects / work-items / comments change.
 */
const CHANGE_SIGNALS_TABLE = "org_change_signals";

/** Bounds signal-burst roster refetches to one list_my_orgs per window. */
const ROSTER_SIGNAL_REFRESH_TTL_MS = 10_000;

/**
 * Establish + maintain the inbound Realtime subscriptions for the signed-in
 * cloud user. No-op when signed out. Re-establishes on userId / endpoint
 * change; refreshes the socket auth token when it rotates.
 */
export function useOrg2CloudRealtime(): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const store = useStore();
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();
  const setRosterVersion = useSetAtom(org2CloudRosterVersionAtom);
  const bumpRosterVersion = useCallback(
    (orgId: string) => {
      setRosterVersion((current) => ({
        ...current,
        [orgId]: (current[orgId] ?? 0) + 1,
      }));
    },
    [setRosterVersion]
  );
  const setRemoteSessionsVersion = useSetAtom(
    org2CloudRemoteSessionsVersionAtom
  );
  const setCommentsSignal = useSetAtom(org2CloudCommentsSignalAtom);
  const bumpOrgCommentsSignal = useCallback(
    (orgId: string) => {
      setCommentsSignal((current) => {
        const key = orgCommentsKey(orgId);
        return { ...current, [key]: (current[key] ?? 0) + 1 };
      });
    },
    [setCommentsSignal]
  );
  const bumpRemoteSessionsVersion = useCallback(
    (orgId: string) => {
      setRemoteSessionsVersion((current) => ({
        ...current,
        [orgId]: (current[orgId] ?? 0) + 1,
      }));
    },
    [setRemoteSessionsVersion]
  );

  const userId = auth?.userId ?? null;
  const endpointUrl = auth?.supabaseUrl ?? null;
  // Membership changes add/remove private Presence topics. supabase-js keeps
  // a leaving topic registered until its async unsubscribe finishes and then
  // rejects adding new Presence callbacks to that already-subscribed channel.
  // A changed org-id set therefore starts one atomic channel generation on a
  // fresh client; token/profile updates still update the existing socket.
  const orgIdsKey = cloudOrgs.map((o) => o.orgId).join(",");

  // Stable refs so the per-org effect and status callbacks read current values
  // without forcing the connection to rebuild.
  const refetchRef = useRef(refetchOrgs);
  const rosterSignalRefreshAtRef = useRef(0);
  const rosterTrailingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  useEffect(() => {
    refetchRef.current = refetchOrgs;
  }, [refetchOrgs]);

  // Auth via ref: the connection rebuilds only on user/endpoint/org-set change.
  // Depending on the `auth` object itself would tear the socket down on every
  // token rotation / profile enrichment (each replaces the atom value), and
  // the Slice B/C subscriptions — whose effect does NOT re-run then — would
  // stay bound to the disposed connection and silently go dead.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // `org_change_signals` also carries rare sharing-floor changes. Refresh only
  // the affected org's entitlement through the shared coordinator
  // (store-keyed single-flight + TTL) instead of using list_my_orgs as a
  // policy cache invalidation mechanism.
  const refreshEntitlementForOrg = useCallback(
    async (orgId: string): Promise<void> => {
      await refreshOrgEntitlement(store, orgId, async () => {
        const current = authRef.current;
        if (!current) return null;
        const fresh = await ensureFreshSession(current);
        if (!fresh) return null;
        commitRefreshedAuth(setAuth, current, fresh);
        return fresh.accessToken;
      });
    },
    [setAuth, store]
  );

  const connectionRef = useRef<Org2CloudRealtimeConnection | null>(null);

  // --- Connection + Slice A (roster). Rebuilds on user / endpoint / org set. ---
  useEffect(() => {
    const current = authRef.current;
    if (!userId || !current) {
      return undefined;
    }
    const connection = createOrg2CloudRealtimeConnection(current.accessToken);
    connectionRef.current = connection;

    // Slice A: the signed-in user's OWN membership rows. Filtering by user_id
    // (not org_id) is what lets a REMOVED member still receive their own
    // removal row — the second RLS SELECT policy (user_id = auth.uid()) keeps
    // it visible after is_org_member() would already return false.
    const unsubRoster = connection.subscribe({
      table: "org_memberships",
      filter: `user_id=eq.${userId}`,
      onChange: () => {
        // Any membership change (removed / re-activated / role change / new
        // org) → re-pull the authoritative roster. Never optimistically mutate.
        void refetchRef.current();
      },
      onStatus: (subscribed) => {
        if (subscribed) {
          // Compensate for events missed before/while (re)subscribing.
          void refetchRef.current();
        }
      },
    });

    return () => {
      unsubRoster();
      connection.dispose();
      connectionRef.current = null;
    };
    // authRef (not auth) on purpose — see the ref comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, endpointUrl, orgIdsKey]);

  // --- Keep the socket's auth token fresh without rebuilding the connection.
  useEffect(() => {
    if (auth?.accessToken) {
      connectionRef.current?.setAuth(auth.accessToken);
    }
  }, [auth?.accessToken]);

  // --- Slice B: per-org change-signal + roster subscriptions. Re-runs when
  // the org set changes so channels track membership. Guarded on the same
  // connection identity as Slice A via connectionRef. These keys match the
  // connection effect, so React installs the new connection before these
  // channel effects run; no extra epoch render/resubscribe is necessary.
  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection || !userId) return undefined;

    const unsubscribes: Array<() => void> = [];
    for (const org of cloudOrgs) {
      const orgId = org.orgId;
      unsubscribes.push(
        connection.subscribe({
          table: CHANGE_SIGNALS_TABLE,
          filter: `org_id=eq.${orgId}`,
          onChange: () => {
            // One scoped, cursor-based pull. The former unconditional roster
            // refetch here re-read list_my_orgs + every org's entitlement for
            // unrelated project/comment/session writes, and the follow-up
            // explicit pass dirtied the just-started pass, doubling all
            // inbound RPCs.
            void org2CloudSyncEngine.invalidateOrgInboundAndWait(orgId);
            void refreshEntitlementForOrg(orgId);
            // Server contract (cloud_rename_org): this signal row is the
            // durable nudge that keeps member-side org names coherent — the
            // roster must refetch on it. TTL-gated so signal bursts cost at
            // most one list_my_orgs per window (entitlements ride their own
            // coordinator; the refetch itself is single-flighted per store).
            const now = Date.now();
            if (
              now - rosterSignalRefreshAtRef.current >=
              ROSTER_SIGNAL_REFRESH_TTL_MS
            ) {
              rosterSignalRefreshAtRef.current = now;
              void refetchRef.current();
            } else if (!rosterTrailingTimerRef.current) {
              // A gated signal is deferred to window expiry, never dropped —
              // it may be the rename/policy change's only nudge.
              const delay =
                ROSTER_SIGNAL_REFRESH_TTL_MS -
                (now - rosterSignalRefreshAtRef.current);
              rosterTrailingTimerRef.current = setTimeout(() => {
                rosterTrailingTimerRef.current = null;
                rosterSignalRefreshAtRef.current = Date.now();
                void refetchRef.current();
              }, delay);
            }
            // The signal covers cloud_sessions too — refresh the sidebar's
            // TEAM SESSIONS rows (teammate shared/forked/retracted a session).
            bumpRemoteSessionsVersion(orgId);
            // Durable fallback for comment CRUD. cloud_session_comments
            // touches this same org_change_signals row, so an open thread
            // refetches even when its low-latency Presence broadcast was
            // missed or the private channel failed to join.
            bumpOrgCommentsSignal(orgId);
          },
          onStatus: (subscribed) => {
            // On (re)subscribe force a complete listing for this org so
            // tombstones (revoked projects / deleted work items / removed
            // tasks) that landed while disconnected are observed.
            if (subscribed) {
              org2CloudSyncEngine.invalidateOrgInbound(orgId, { full: true });
              void refreshEntitlementForOrg(orgId);
              bumpRemoteSessionsVersion(orgId);
              bumpOrgCommentsSignal(orgId);
            }
          },
        })
      );
      // Org-wide roster: a TEAMMATE joining/leaving/changing role (Slice A
      // only carries the signed-in user's OWN rows). Bumps the per-org
      // version counter; CloudOrgPanelView keys its fetch on it so the
      // members list updates live while the panel is open.
      unsubscribes.push(
        connection.subscribe({
          table: "org_memberships",
          filter: `org_id=eq.${orgId}`,
          onChange: () => {
            bumpRosterVersion(orgId);
          },
          onStatus: (subscribed) => {
            // Compensate for roster events missed while disconnected.
            if (subscribed) bumpRosterVersion(orgId);
          },
        })
      );
    }
    log.info(
      `realtime: subscribed inbound planes for ${cloudOrgs.length} org(s)`
    );

    return () => {
      for (const unsub of unsubscribes) unsub();
    };
    // orgIdsKey captures membership churn; connection identity is tracked by
    // the Slice A effect (userId/endpointUrl/orgIdsKey) which rebuilds
    // connectionRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    orgIdsKey,
    userId,
    endpointUrl,
    bumpRosterVersion,
    bumpRemoteSessionsVersion,
    bumpOrgCommentsSignal,
    refreshEntitlementForOrg,
  ]);

  // --- Slice C: org-level presence (who is viewing what), one channel per org.
  const setPresence = useSetAtom(org2CloudPresenceAtom);
  const setOutboundPresence = useSetAtom(org2CloudPresenceOutboundAtom);
  // Presence follows the session the shared Chat pipeline is actually
  // rendering. Secondary/imported tabs intentionally diverge from the
  // WorkStation's remembered selection, so publishing that remembered id
  // makes two users viewing the same cloud replay advertise different rows.
  const activeSessionId = useAtomValue(activeSessionIdAtom) ?? "";
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const sessions = useAtomValue(sessionsAtom) as Session[];
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const remoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);
  const displayName = auth?.profile?.displayName ?? "";

  const viewing = useMemo(() => {
    if (!activeSessionId) return [];
    const session = sessions.find(
      (candidate) => candidate.session_id === activeSessionId
    );
    if (!session || !activeCloudOrgId) return [];
    return resolveCloudSessionRefs(
      session,
      cloudOrgIdsForSession(sessionOrgTags, session.session_id),
      Object.values(remoteSessions).flatMap((entry) => entry.rows),
      userId
    ).filter((ref) => ref.orgId === activeCloudOrgId);
  }, [
    activeCloudOrgId,
    activeSessionId,
    remoteSessions,
    sessionOrgTags,
    sessions,
    userId,
  ]);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  const presenceHandlesRef = useRef(new Map<string, Org2CloudPresenceHandle>());
  const buildPayload = useCallback(
    (orgId: string): Record<string, unknown> | null => {
      const current = (viewingRef.current ?? []).find(
        (ref) => ref.orgId === orgId
      );
      // Joining a private channel is still required for inbound awareness and
      // comment broadcasts, but inactive orgs must not publish empty Presence
      // metas. Supabase limits track/untrack across the whole connection.
      if (!current) return null;
      return {
        displayName: authRef.current?.profile?.displayName ?? "",
        viewingSessionId: current.bareSessionId,
        updatedAt: Date.now(),
      };
    },
    []
  );

  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection || !userId) return undefined;
    const handles = presenceHandlesRef.current;
    const unregisters: Array<() => void> = [];
    for (const org of cloudOrgs) {
      const orgId = org.orgId;
      const handle = connection.joinPresence({
        scope: `org:${orgId}`,
        key: userId,
        payload: buildPayload(orgId),
        onBroadcast: (event, payload) => {
          if (event !== COMMENTS_CHANGED_EVENT) return;
          const sessionId = payload.sessionId;
          if (typeof sessionId !== "string" || !sessionId) return;
          setCommentsSignal((current) => {
            const key = sessionCommentsKey(orgId, sessionId);
            return { ...current, [key]: (current[key] ?? 0) + 1 };
          });
          bumpRemoteSessionsVersion(orgId);
        },
        onSync: (state) => {
          const byUser: Record<string, Org2CloudPresenceEntry> = {};
          for (const [presenceKey, metas] of Object.entries(state)) {
            const meta = latestPresenceMeta(metas);
            byUser[presenceKey] = {
              userId: presenceKey,
              displayName: String(meta.displayName ?? ""),
              viewingSessionId:
                typeof meta.viewingSessionId === "string"
                  ? meta.viewingSessionId
                  : null,
              updatedAt: Number.isFinite(Number(meta.updatedAt))
                ? Number(meta.updatedAt)
                : undefined,
            };
          }
          setPresence((current) => ({ ...current, [orgId]: byUser }));
        },
      });
      handles.set(orgId, handle);
      const unregister = registerCommentsBroadcaster(orgId, (event, payload) =>
        handle.send(event, payload)
      );
      unregisters.push(unregister);
    }
    return () => {
      for (const unregister of unregisters.splice(0)) unregister();
      for (const [orgId, handle] of handles) {
        handle.leave();
        setPresence((current) => {
          const next = { ...current };
          delete next[orgId];
          return next;
        });
      }
      handles.clear();
    };
    // Same lifetime contract as Slice B (connection identity via Slice A).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    orgIdsKey,
    userId,
    endpointUrl,
    buildPayload,
    setPresence,
    setCommentsSignal,
    bumpRemoteSessionsVersion,
  ]);

  // Keep awareness attached to the session this app has open even while its
  // window is in the background. On desktop only one app window can be
  // foreground at a time; clearing on blur made two-device collaboration
  // flicker and made every other viewer disappear as soon as focus moved.
  // Navigation and channel teardown remain the authoritative leave signals.
  useEffect(() => {
    for (const [orgId, handle] of presenceHandlesRef.current) {
      const payload = buildPayload(orgId);
      handle.update(payload);
      setOutboundPresence((current) => ({
        ...current,
        [orgId]: {
          viewingSessionId:
            payload && typeof payload.viewingSessionId === "string"
              ? payload.viewingSessionId
              : null,
          updatedAt: payload ? Number(payload.updatedAt) : Date.now(),
          updateCount: (current[orgId]?.updateCount ?? 0) + 1,
        },
      }));
    }
  }, [viewing, displayName, buildPayload, setOutboundPresence]);
}
