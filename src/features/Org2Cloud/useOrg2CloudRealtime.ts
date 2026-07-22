/**
 * ORG2 Cloud inbound-sync Realtime manager (design: cloud-sync-supabase-realtime).
 *
 * Replaces 60s polling as the PRIMARY inbound trigger with Supabase Postgres
 * Changes. Mounted once in the router root beside `useOrg2CloudOrgs` /
 * `useOrg2CloudSyncEngine`. Owns one Realtime connection per signed-in
 * session/endpoint/active-org generation and drives two inbound slices:
 *
 *  - Slice A (roster):   while a cloud org is active, subscribe
 *                        `org_memberships` filtered to the current user; any
 *                        change → `refetchOrgs()` (`list_my_orgs`), the single
 *                        source of truth. The subscribe true-edge compensates
 *                        for membership changes missed while no org was open.
 *  - Slice B (signals):  subscribe the actively-used org's durable, coarse
 *                        `org_change_signals` row. Plane-specific Presence
 *                        broadcasts drive the normal live path; the coarse
 *                        row is rate-limited to one recovery pull per minute
 *                        so unrelated planes cannot invalidate one another
 *                        on every write.
 *
 * Realtime is an INVALIDATION signal only: the data still arrives through the
 * existing RPC pull paths, so no cursor/tombstone logic is duplicated here. The
 * sync engine keeps a low-frequency fallback pass (see org2CloudSyncEngine) so
 * a dropped socket still reaches eventual consistency.
 *
 * On (re)subscribe the true-edge of `onStatus` forces a compensating full pull
 * (roster refetch for A; inbound/session/policy recovery for B) to recover any
 * events missed while disconnected.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import {
  cloudOrgIdsForSession,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { chatPanelSelectedCloudOrgAtom } from "@src/store/ui/chatPanelAtom";

import { org2CloudSharingFloorAtom } from "./org2CloudAccessSettings";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import {
  COMMENTS_CHANGED_EVENT,
  bumpCommentsSignalKey,
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
  registerCommentsBroadcaster,
  sessionCommentsKey,
} from "./org2CloudCommentsBus";
import {
  ORG_CONTROL_CHANGED_EVENT,
  parseOrgControlChangeKind,
  registerOrgControlBroadcaster,
} from "./org2CloudControlBus";
import { refreshOrgEntitlement } from "./org2CloudEntitlementCoordinator";
import { org2CloudMemberNamesAtom } from "./org2CloudMemberNamesAtom";
import { clearCloudOrgMembersCache } from "./org2CloudMembersCoordinator";
import {
  org2CloudOrgsAtom,
  org2CloudRosterRealtimeConnectedAtom,
  org2CloudRosterVersionAtom,
  sidebarActiveCloudOrgIdAtom,
  useRefetchOrg2CloudOrgs,
} from "./org2CloudOrgsAtom";
import {
  type Org2CloudPresenceEntry,
  type Org2CloudPresencePayload,
  PRESENCE_VIEW_CHANGED_EVENT,
  applyOrg2CloudPresenceViewChanged,
  latestPresenceMeta,
  org2CloudPresenceAtom,
  org2CloudPresenceOutboundAtom,
  org2CloudPresencePayloadKey,
  org2CloudPresenceRosterEquals,
  resolveCloudSessionRefs,
} from "./org2CloudPresenceAtom";
import {
  type Org2CloudPresenceHandle,
  type Org2CloudRealtimeConnection,
  createOrg2CloudRealtimeConnection,
} from "./org2CloudRealtimeClient";
import { resolveActiveRealtimeOrgId } from "./org2CloudRealtimeScope";
import {
  org2CloudRemoteSessionsAtom,
  org2CloudRemoteSessionsVersionAtom,
  remoteSessionsEntryForIdentity,
} from "./org2CloudRemoteSessionsAtom";
import { org2CloudSessionCommentsAtom } from "./org2CloudSessionCommentsAtom";
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

/**
 * The backend's durable signal is intentionally coarse. Plane-specific
 * Presence broadcasts provide the live path; this bounded trailing fallback
 * recovers missed broadcasts without turning every session write into five
 * unrelated RPCs.
 */
const COARSE_SIGNAL_FALLBACK_MS = 60_000;
const CONTROL_PLANE_FALLBACK_MS = 5 * 60_000;

function isDocumentHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/**
 * Establish + maintain the inbound Realtime subscriptions for the signed-in
 * cloud user. No-op when signed out or outside a cloud-org scope.
 * Re-establishes on userId / endpoint / active-org change; refreshes the
 * socket auth token when it rotates.
 */
export function useOrg2CloudRealtime(): void {
  const auth = useAtomValue(org2CloudAuthAtom);
  const store = useStore();
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const requestedActiveCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const managedCloudOrgId =
    useAtomValue(chatPanelSelectedCloudOrgAtom)?.orgId ?? null;
  const activeRealtimeOrgId = resolveActiveRealtimeOrgId(
    cloudOrgs,
    requestedActiveCloudOrgId,
    managedCloudOrgId
  );
  const refetchOrgs = useRefetchOrg2CloudOrgs();
  const setRosterVersion = useSetAtom(org2CloudRosterVersionAtom);
  const setRosterRealtimeConnected = useSetAtom(
    org2CloudRosterRealtimeConnectedAtom
  );
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
  const setSessionComments = useSetAtom(org2CloudSessionCommentsAtom);
  const setPresence = useSetAtom(org2CloudPresenceAtom);
  const setOutboundPresence = useSetAtom(org2CloudPresenceOutboundAtom);
  const setRemoteSessions = useSetAtom(org2CloudRemoteSessionsAtom);
  const bumpOrgCommentsSignal = useCallback(
    (orgId: string) => {
      setCommentsSignal((current) =>
        bumpCommentsSignalKey(current, orgCommentsKey(orgId))
      );
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
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const setMemberNames = useSetAtom(org2CloudMemberNamesAtom);
  useLayoutEffect(() => {
    // Cached rosters and derived display names are identity-owned. Evict them
    // on sign-out/account/endpoint changes instead of merely hiding old rows.
    clearCloudOrgMembersCache(store);
    setMemberNames({});
    setRosterVersion({});
    setRosterRealtimeConnected({});
    setRemoteSessions({});
    setRemoteSessionsVersion({});
    setSessionComments({});
    setCommentsSignal({});
    setPresence({});
    setOutboundPresence({});
  }, [
    authIdentityKey,
    setCommentsSignal,
    setMemberNames,
    setOutboundPresence,
    setPresence,
    setRemoteSessions,
    setRemoteSessionsVersion,
    setRosterVersion,
    setRosterRealtimeConnected,
    setSessionComments,
    store,
  ]);
  // Stable refs so the per-org effect and status callbacks read current values
  // without forcing the connection to rebuild.
  const refetchRef = useRef(refetchOrgs);
  const coarseSignalRefreshAtRef = useRef(0);
  const controlPlaneRefreshAtRef = useRef(0);
  const coarseSignalTrailingTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const hiddenRecoveryRef = useRef<{
    orgId: string;
    pushSessions: boolean;
  } | null>(null);
  const deferHiddenRecovery = useCallback(
    (orgId: string, pushSessions: boolean) => {
      const previous = hiddenRecoveryRef.current;
      hiddenRecoveryRef.current = {
        orgId,
        pushSessions:
          pushSessions ||
          (previous?.orgId === orgId && previous.pushSessions === true),
      };
    },
    []
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
    async (orgId: string): Promise<boolean> => {
      const before = store.get(org2CloudSharingFloorAtom)[orgId];
      await refreshOrgEntitlement(store, orgId, async () => {
        const current = authRef.current;
        if (!current) return null;
        const fresh = await ensureFreshSession(current);
        if (!fresh) return null;
        commitRefreshedAuth(setAuth, current, fresh);
        return fresh.accessToken;
      });
      return store.get(org2CloudSharingFloorAtom)[orgId] !== before;
    },
    [setAuth, store]
  );

  const connectionRef = useRef<Org2CloudRealtimeConnection | null>(null);

  // Realtime channels stay joined while hidden, but network pulls do not.
  // Collapse every hidden nudge into one full recovery when the window is
  // visible again; a hidden scopes change also re-evaluates local uploads.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const recoverWhenVisible = () => {
      if (isDocumentHidden()) return;
      const pending = hiddenRecoveryRef.current;
      if (!pending || pending.orgId !== activeRealtimeOrgId) return;
      hiddenRecoveryRef.current = null;
      void (async () => {
        const [, floorChanged] = await Promise.all([
          refetchRef.current(),
          refreshEntitlementForOrg(pending.orgId),
        ]);
        org2CloudSyncEngine.invalidateOrgInbound(pending.orgId, {
          full: true,
          pushSessions: pending.pushSessions || floorChanged,
        });
      })();
      setRemoteSessions((current) => {
        if (!(pending.orgId in current)) return current;
        const next = { ...current };
        delete next[pending.orgId];
        return next;
      });
      bumpRemoteSessionsVersion(pending.orgId);
      bumpOrgCommentsSignal(pending.orgId);
    };
    document.addEventListener("visibilitychange", recoverWhenVisible);
    return () =>
      document.removeEventListener("visibilitychange", recoverWhenVisible);
  }, [
    activeRealtimeOrgId,
    bumpOrgCommentsSignal,
    bumpRemoteSessionsVersion,
    refreshEntitlementForOrg,
    setRemoteSessions,
  ]);

  // --- Connection + Slice A (roster). Rebuilds on user / endpoint / active
  // org. A fresh connection on scope switch avoids supabase-js reusing a
  // presence topic whose asynchronous leave has not finished yet.
  useEffect(() => {
    const current = authRef.current;
    if (!userId || !current || !activeRealtimeOrgId) {
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
  }, [userId, endpointUrl, activeRealtimeOrgId]);

  // --- Keep the socket's auth token fresh without rebuilding the connection.
  useEffect(() => {
    if (auth?.accessToken) {
      connectionRef.current?.setAuth(auth.accessToken);
    }
  }, [auth?.accessToken]);

  // --- Slice B: change-signal + roster subscriptions for the active org only.
  // Inactive orgs rely on the sync engine's bounded fallback pass and catch up
  // immediately when selected; they must not keep reconnecting broken channels
  // or pulling data while the user is working elsewhere.
  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection || !userId || !activeRealtimeOrgId) return undefined;

    const unsubscribes: Array<() => void> = [];
    const orgId = activeRealtimeOrgId;
    const runCoarseSignalFallback = () => {
      const now = Date.now();
      coarseSignalRefreshAtRef.current = now;
      if (isDocumentHidden()) {
        deferHiddenRecovery(orgId, false);
        return;
      }
      org2CloudSyncEngine.invalidateOrgInbound(orgId);
      bumpRemoteSessionsVersion(orgId);
      bumpOrgCommentsSignal(orgId);
      if (now - controlPlaneRefreshAtRef.current >= CONTROL_PLANE_FALLBACK_MS) {
        controlPlaneRefreshAtRef.current = now;
        void refetchRef.current();
        void refreshEntitlementForOrg(orgId).then((floorChanged) => {
          if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
        });
      }
    };
    const scheduleCoarseSignalFallback = () => {
      const now = Date.now();
      const elapsed = now - coarseSignalRefreshAtRef.current;
      if (elapsed >= COARSE_SIGNAL_FALLBACK_MS) {
        runCoarseSignalFallback();
        return;
      }
      if (coarseSignalTrailingTimerRef.current) return;
      coarseSignalTrailingTimerRef.current = setTimeout(() => {
        coarseSignalTrailingTimerRef.current = null;
        runCoarseSignalFallback();
      }, COARSE_SIGNAL_FALLBACK_MS - elapsed);
    };
    unsubscribes.push(
      connection.subscribe({
        table: CHANGE_SIGNALS_TABLE,
        filter: `org_id=eq.${orgId}`,
        onChange: () => {
          // This row carries no plane/entity discriminator. Treat it only as
          // a bounded durable fallback; plane-specific Presence broadcasts
          // below keep normal session/comment/control changes immediate.
          scheduleCoarseSignalFallback();
        },
        onStatus: (subscribed) => {
          // On (re)subscribe force a complete listing for this org so
          // tombstones (revoked projects / deleted work items / removed
          // tasks) that landed while disconnected are observed.
          if (subscribed) {
            coarseSignalRefreshAtRef.current = Date.now();
            controlPlaneRefreshAtRef.current = Date.now();
            if (isDocumentHidden()) {
              deferHiddenRecovery(orgId, false);
              return;
            }
            org2CloudSyncEngine.invalidateOrgInbound(orgId, {
              full: true,
              pushSessions: true,
            });
            void refreshEntitlementForOrg(orgId).then((floorChanged) => {
              if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
            });
            // Force a complete session listing after a disconnected window;
            // subsequent invalidations use its server cursor.
            setRemoteSessions((current) => {
              if (!(orgId in current)) return current;
              const next = { ...current };
              delete next[orgId];
              return next;
            });
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
          setRosterRealtimeConnected((current) =>
            current[orgId] === subscribed
              ? current
              : { ...current, [orgId]: subscribed }
          );
          // Compensate for roster events missed while disconnected.
          if (subscribed) bumpRosterVersion(orgId);
        },
      })
    );
    log.info(`realtime: subscribed inbound planes for active org ${orgId}`);

    return () => {
      for (const unsub of unsubscribes) unsub();
      setRosterRealtimeConnected((current) => {
        if (!(orgId in current)) return current;
        const next = { ...current };
        delete next[orgId];
        return next;
      });
      if (coarseSignalTrailingTimerRef.current) {
        clearTimeout(coarseSignalTrailingTimerRef.current);
        coarseSignalTrailingTimerRef.current = null;
      }
    };
    // Connection identity follows the same activeRealtimeOrgId key in Slice A.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRealtimeOrgId,
    userId,
    endpointUrl,
    bumpRosterVersion,
    bumpRemoteSessionsVersion,
    bumpOrgCommentsSignal,
    refreshEntitlementForOrg,
  ]);

  // --- Slice C: org-level presence for the actively-used org only.
  // Presence follows the session the shared Chat pipeline is actually
  // rendering. Secondary/imported tabs intentionally diverge from the
  // WorkStation's remembered selection, so publishing that remembered id
  // makes two users viewing the same cloud replay advertise different rows.
  const activeSessionId = useAtomValue(activeSessionIdAtom) ?? "";
  const sessions = useAtomValue(sessionsAtom) as Session[];
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const remoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);
  const displayName = auth?.profile?.displayName ?? "";

  const viewing = useMemo(() => {
    if (!activeSessionId) return [];
    const session = sessions.find(
      (candidate) => candidate.session_id === activeSessionId
    );
    if (!session || !activeRealtimeOrgId) return [];
    return resolveCloudSessionRefs(
      session,
      cloudOrgIdsForSession(sessionOrgTags, session.session_id),
      remoteSessionsEntryForIdentity(
        remoteSessions[activeRealtimeOrgId],
        authIdentityKey
      )?.rows ?? [],
      userId
    ).filter((ref) => ref.orgId === activeRealtimeOrgId);
  }, [
    activeRealtimeOrgId,
    activeSessionId,
    authIdentityKey,
    remoteSessions,
    sessionOrgTags,
    sessions,
    userId,
  ]);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  const presenceHandlesRef = useRef(new Map<string, Org2CloudPresenceHandle>());
  const presencePayloadKeysRef = useRef(new Map<string, string | null>());
  const buildPayload = useCallback(
    (orgId: string): Org2CloudPresencePayload | null => {
      const current = (viewingRef.current ?? []).find(
        (ref) => ref.orgId === orgId
      );
      // The active org channel may be open before a cloud session is selected;
      // avoid publishing an empty Presence meta in that state.
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
    if (!connection || !userId || !activeRealtimeOrgId) return undefined;
    const handles = presenceHandlesRef.current;
    const payloadKeys = presencePayloadKeysRef.current;
    const unregisters: Array<() => void> = [];
    const orgId = activeRealtimeOrgId;
    const initialPayload = buildPayload(orgId);
    const handle = connection.joinPresence({
      scope: `org:${orgId}`,
      key: userId,
      payload: initialPayload,
      onBroadcast: (event, payload) => {
        if (event === ORG_CONTROL_CHANGED_EVENT) {
          const kind = parseOrgControlChangeKind(payload);
          if (kind && isDocumentHidden()) {
            deferHiddenRecovery(
              orgId,
              kind === "scopes" || kind === "entitlement"
            );
            return;
          }
          if (kind === "entitlement") {
            void refreshEntitlementForOrg(orgId).then((floorChanged) => {
              if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
            });
          } else if (kind === "roster") {
            void refetchRef.current();
          } else if (kind === "scopes") {
            org2CloudSyncEngine.resumeOrg(orgId);
          } else if (kind === "sessions") {
            bumpRemoteSessionsVersion(orgId);
          }
          return;
        }
        if (event === PRESENCE_VIEW_CHANGED_EVENT) {
          setPresence((current) =>
            applyOrg2CloudPresenceViewChanged(current, orgId, payload)
          );
          return;
        }
        if (event !== COMMENTS_CHANGED_EVENT) return;
        const sessionId = payload.sessionId;
        if (typeof sessionId !== "string" || !sessionId) return;
        if (isDocumentHidden()) {
          deferHiddenRecovery(orgId, false);
          return;
        }
        setCommentsSignal((current) =>
          bumpCommentsSignalKey(current, sessionCommentsKey(orgId, sessionId))
        );
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
        // Presence sync fires for reconnects and same-truth re-tracks too.
        // Keep the previous atom value when the who-views-what roster is
        // semantically unchanged so every presence consumer (sidebar menu
        // tree, viewer chips) skips a full rebuild.
        setPresence((current) =>
          org2CloudPresenceRosterEquals(current[orgId], byUser)
            ? current
            : { ...current, [orgId]: byUser }
        );
      },
    });
    handles.set(orgId, handle);
    payloadKeys.set(orgId, org2CloudPresencePayloadKey(initialPayload));
    setOutboundPresence((current) => ({
      ...current,
      [orgId]: {
        viewingSessionId: initialPayload?.viewingSessionId ?? null,
        updatedAt: initialPayload?.updatedAt ?? Date.now(),
        updateCount: (current[orgId]?.updateCount ?? 0) + 1,
      },
    }));
    const unregister = registerCommentsBroadcaster(orgId, (event, payload) =>
      handle.send(event, payload)
    );
    unregisters.push(unregister);
    unregisters.push(
      registerOrgControlBroadcaster(orgId, (event, payload) =>
        handle.send(event, payload)
      )
    );
    return () => {
      for (const unregister of unregisters.splice(0)) unregister();
      for (const [orgId, handle] of handles) {
        handle.leave();
        setPresence((current) => {
          const next = { ...current };
          delete next[orgId];
          return next;
        });
        setOutboundPresence((current) => {
          const next = { ...current };
          delete next[orgId];
          return next;
        });
      }
      handles.clear();
      payloadKeys.clear();
    };
    // Same lifetime contract as Slice B (connection identity via Slice A).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRealtimeOrgId,
    userId,
    endpointUrl,
    buildPayload,
    setPresence,
    setOutboundPresence,
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
      const payloadKey = org2CloudPresencePayloadKey(payload);
      if (
        presencePayloadKeysRef.current.has(orgId) &&
        presencePayloadKeysRef.current.get(orgId) === payloadKey
      ) {
        continue;
      }
      presencePayloadKeysRef.current.set(orgId, payloadKey);
      handle.update(payload);
      const updatedAt = payload?.updatedAt ?? Date.now();
      handle.send(PRESENCE_VIEW_CHANGED_EVENT, {
        userId,
        viewingSessionId: payload?.viewingSessionId ?? null,
        updatedAt,
      });
      setOutboundPresence((current) => ({
        ...current,
        [orgId]: {
          viewingSessionId:
            payload && typeof payload.viewingSessionId === "string"
              ? payload.viewingSessionId
              : null,
          updatedAt,
          updateCount: (current[orgId]?.updateCount ?? 0) + 1,
        },
      }));
    }
  }, [viewing, displayName, userId, buildPayload, setOutboundPresence]);
}
