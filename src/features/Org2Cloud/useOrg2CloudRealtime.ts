/**
 * ORG2 Cloud inbound-sync Realtime manager (design: cloud-sync-supabase-realtime).
 *
 * Uses Supabase Postgres Changes instead of recurring inbound polls. Mounted
 * once in the router root beside `useOrg2CloudOrgs` /
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
 *                        on every write. Broadcast backends carry the signal
 *                        as per-kind `org-db-changed` events on the org
 *                        channel instead, dispatched narrowly per plane with
 *                        the same 60s window per plane.
 *
 * Realtime is an INVALIDATION signal only: the data still arrives through the
 * existing RPC pull paths, so no cursor/tombstone logic is duplicated here. The
 * A dropped/released socket is recovered by the channel's reconnect true-edge,
 * visibility regain, and explicit user/network events; there is no recurring
 * cloud sync pass.
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
  useState,
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
import { isMainAppWindow } from "@src/util/platform/tauri/windowIdentity";

import {
  bumpConversationPlaneSignal,
  conversationPlaneSignalAtom,
} from "./SessionConversation/conversationPlaneAtom";
import {
  bumpOrg2CloudChannelMessagesVersionAtom,
  bumpOrg2CloudChannelsVersionAtom,
  org2CloudChannelMessagesVersionAtom,
  org2CloudChannelsVersionAtom,
} from "./channels/channelsAtom";
import { getFreshCloudAccessToken } from "./cloudShortId";
import { startCrossWindowFocusPublisher } from "./crossWindowFocus";
import { org2CloudSharingFloorAtom } from "./org2CloudAccessSettings";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import { getCloudCapabilities } from "./org2CloudCapabilities";
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
  ORG_DB_CHANGED_EVENT,
  type Org2CloudDbChangeKind,
  parseOrgControlChangeKind,
  parseOrgDbChangeKind,
  registerOrgControlBroadcaster,
} from "./org2CloudControlBus";
import { refreshOrgEntitlement } from "./org2CloudEntitlementCoordinator";
import { org2CloudMemberNamesAtom } from "./org2CloudMemberNamesAtom";
import { clearCloudOrgMembersCache } from "./org2CloudMembersCoordinator";
import { endpointForOrigin } from "./org2CloudOrgEndpointRouter";
import {
  org2CloudMemberRuntimeVersionAtom,
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
import { useOrg2CloudRealtimeLease } from "./org2CloudRealtimeLease";
import { decideSubscribedEdgeRecovery } from "./org2CloudRealtimeRecovery";
import { resolveActiveRealtimeOrgId } from "./org2CloudRealtimeScope";
import {
  Org2CloudRealtimeSignalCoalescer,
  STORM_SIGNAL_COALESCE_MS,
} from "./org2CloudRealtimeSignalCoalescer";
import {
  bumpRemoteSessionsInvalidation,
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
 * Realtime needs. Server triggers bump one row per org on
 * projects / work-items / comments / SESSIONS changes (session-row
 * writes were verified to broadcast on 2026-08-06 — an earlier version
 * of this comment under-claimed the coverage).
 */
const CHANGE_SIGNALS_TABLE = "org_change_signals";

/**
 * The backend's durable signal is intentionally coarse. Plane-specific
 * Presence broadcasts provide the live path; the durable coarse row is a
 * secondary event source. A short leading/trailing window coalesces
 * transaction bursts without delaying a teammate notification. It does not
 * schedule polling when no signal arrives.
 */
const CONTROL_PLANE_REFRESH_THROTTLE_MS = 5 * 60_000;

/**
 * Throttle keys for the trailing-edge signal refreshes: one per narrowed
 * dispatch target ("inbound" covers projects + workItems, which run the same
 * action) plus "coarse" for the legacy all-planes refresh.
 */
type SignalPlane =
  | "coarse"
  | "sessions"
  | "comments"
  | "inbound"
  | "roster"
  | "policy"
  | "channels"
  | "channelMessages"
  | "memberRuntime"
  | "conversationEvents";

const ALL_SIGNAL_PLANES: readonly SignalPlane[] = [
  "coarse",
  "sessions",
  "comments",
  "inbound",
  "roster",
  "policy",
  "channels",
  "channelMessages",
  "memberRuntime",
  "conversationEvents",
];

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
  const requestedRealtimeOrgId = resolveActiveRealtimeOrgId(
    cloudOrgs,
    requestedActiveCloudOrgId,
    managedCloudOrgId
  );
  const realtimeLeaseHeld = useOrg2CloudRealtimeLease();
  const activeRealtimeOrgId = realtimeLeaseHeld ? requestedRealtimeOrgId : null;
  const refetchOrgs = useRefetchOrg2CloudOrgs();
  const setRosterVersion = useSetAtom(org2CloudRosterVersionAtom);
  const bumpChannelsVersion = useSetAtom(bumpOrg2CloudChannelsVersionAtom);
  const setChannelsVersion = useSetAtom(org2CloudChannelsVersionAtom);
  const setChannelMessagesVersion = useSetAtom(
    org2CloudChannelMessagesVersionAtom
  );
  const bumpChannelMessagesForOrg = useSetAtom(
    bumpOrg2CloudChannelMessagesVersionAtom
  );
  // The signal carries the org, not the channel, so every open channel of
  // that org re-runs its bounded delta pull (`p_since`), not a full re-list.
  const bumpChannelMessagesVersion = useCallback(
    (orgId: string) => {
      bumpChannelMessagesForOrg({ orgId });
    },
    [bumpChannelMessagesForOrg]
  );
  const setConversationPlaneSignal = useSetAtom(conversationPlaneSignalAtom);
  const bumpConversationPlaneVersion = useCallback(
    (orgId: string) => {
      bumpConversationPlaneSignal(setConversationPlaneSignal, orgId);
    },
    [setConversationPlaneSignal]
  );
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
  const setMemberRuntimeVersion = useSetAtom(org2CloudMemberRuntimeVersionAtom);
  const bumpMemberRuntimeVersion = useCallback(
    (orgId: string) => {
      setMemberRuntimeVersion((current) => ({
        ...current,
        [orgId]: (current[orgId] ?? 0) + 1,
      }));
    },
    [setMemberRuntimeVersion]
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
  const bumpActiveSessionCommentsSignal = useCallback(
    (orgId: string) => {
      const activeSessionId = store.get(activeSessionIdAtom);
      if (!activeSessionId) return;
      setCommentsSignal((current) =>
        bumpCommentsSignalKey(
          current,
          sessionCommentsKey(orgId, activeSessionId)
        )
      );
    },
    [setCommentsSignal, store]
  );
  const bumpRemoteSessionsVersion = useCallback(
    (orgId: string, options: { full?: boolean } = {}) => {
      setRemoteSessionsVersion((current) =>
        bumpRemoteSessionsInvalidation(current, orgId, options)
      );
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
    setMemberRuntimeVersion({});
    setRosterRealtimeConnected({});
    setRemoteSessions({});
    setRemoteSessionsVersion({});
    setSessionComments({});
    setCommentsSignal({});
    setPresence({});
    setOutboundPresence({});
    setChannelsVersion({});
    setChannelMessagesVersion({});
  }, [
    authIdentityKey,
    setChannelMessagesVersion,
    setChannelsVersion,
    setCommentsSignal,
    setMemberNames,
    setMemberRuntimeVersion,
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
  const signalCoalescerRef = useRef(
    new Org2CloudRealtimeSignalCoalescer<SignalPlane>()
  );
  const controlPlaneRefreshAtRef = useRef(0);
  const coarseSafetyNetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  // Disconnect-duration bookkeeping for the SUBSCRIBED-edge recovery policy:
  // short gaps and rejoin storms downgrade to delta pulls, long gaps run the
  // authoritative full recovery (see org2CloudRealtimeRecovery).
  const orgTeardownAtRef = useRef(new Map<string, number>());
  const orgFullRecoveryAtRef = useRef(new Map<string, number>());
  const connectionTeardownAtRef = useRef<number | undefined>(undefined);
  const rosterEdgeRefetchAtRef = useRef<number | undefined>(undefined);
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

  // 0005 capability: change signals arrive as server broadcasts on the org
  // channel instead of postgres_changes. `false` covers legacy backends AND
  // the unresolved-probe window — the legacy channels stay up until the probe
  // flips, so no signal is ever lost; pre-0005 backends never flip, so their
  // subscription topology never churns.
  const [broadcastSignals, setBroadcastSignals] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the previous identity/endpoint capability before the asynchronous probe can publish a result
    setBroadcastSignals(false);
    const current = authRef.current;
    if (!userId || !current) return undefined;
    void (async () => {
      const fresh = await ensureFreshSession(current);
      if (!fresh || cancelled) return;
      commitRefreshedAuth(setAuth, current, fresh);
      const capabilities = await getCloudCapabilities(
        fresh.accessToken,
        endpointForOrigin(fresh.supabaseUrl)
      );
      if (!cancelled && capabilities.broadcastSignals) {
        setBroadcastSignals(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, endpointUrl, setAuth]);

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

  // EVERY window (main and detached) advertises its focus state so the main
  // window's lease treats "the app is foregrounded in ANY window" as
  // foreground — a user working in a detached window must not cost main its
  // socket after the blur grace.
  useEffect(() => startCrossWindowFocusPublisher(), []);

  // --- Connection + Slice A (roster). Rebuilds on user / endpoint / active
  // org. A fresh connection on scope switch avoids supabase-js reusing a
  // presence topic whose asynchronous leave has not finished yet.
  useEffect(() => {
    const current = authRef.current;
    // Socket ownership is main-window-only: a secondary window opening a
    // second Realtime connection would double the billable socket count and
    // flap Presence (the presence key is the userId, so two windows publish
    // two metas for one user). Main's webview is never destroyed while the
    // app runs, so this ownership rule is stable.
    if (!isMainAppWindow() || !userId || !current || !activeRealtimeOrgId) {
      return undefined;
    }
    const connection = createOrg2CloudRealtimeConnection(
      getFreshCloudAccessToken
    );
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
        if (!subscribed) return;
        // Compensate for events missed before/while (re)subscribing. Roster
        // changes are rare: a short gap (org switch, brief reconnect) keeps
        // the last authoritative roster instead of re-listing plus the ×N
        // entitlement fan-out on every edge.
        const decision = decideSubscribedEdgeRecovery({
          nowMs: Date.now(),
          teardownAtMs: connectionTeardownAtRef.current,
          lastFullRecoveryAtMs: rosterEdgeRefetchAtRef.current,
        });
        if (decision === "full") {
          rosterEdgeRefetchAtRef.current = Date.now();
          void refetchRef.current();
        }
      },
    });

    return () => {
      unsubRoster();
      connection.dispose();
      connectionRef.current = null;
      connectionTeardownAtRef.current = Date.now();
    };
    // authRef (not auth) on purpose — see the ref comment above.
  }, [userId, endpointUrl, activeRealtimeOrgId]);

  // --- Nudge the socket to re-resolve its token as soon as the atom
  // rotates; the heartbeat-driven callback refresh covers the steady state.
  useEffect(() => {
    if (auth?.accessToken) {
      connectionRef.current?.setAuth();
    }
  }, [auth?.accessToken]);

  // Low-frequency control-plane guard shared by every signal path: any
  // signal arms the 5-min refetchOrgs + entitlement TTL check.
  const maybeRefreshControlPlane = useCallback(
    (orgId: string) => {
      const now = Date.now();
      if (
        now - controlPlaneRefreshAtRef.current <
        CONTROL_PLANE_REFRESH_THROTTLE_MS
      ) {
        return;
      }
      controlPlaneRefreshAtRef.current = now;
      void refetchRef.current();
      void refreshEntitlementForOrg(orgId).then((floorChanged) => {
        if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
      });
    },
    [refreshEntitlementForOrg]
  );

  // Shared by the Slice B postgres_changes path (legacy backends) and the
  // Slice C safety net (per-kind backends): identical short coalescing and
  // refresh behavior regardless of transport.
  const runCoarseSignalRefresh = useCallback(() => {
    const orgId = activeRealtimeOrgId;
    if (!orgId) return;
    // Hidden check FIRST (same reorder as the edge-recovery fix): the
    // safety-net timer calls this directly, and a hidden-skipped run must
    // not mark the planes handled while doing none of the refreshes.
    if (isDocumentHidden()) return;
    signalCoalescerRef.current.markHandled([
      "coarse",
      "sessions",
      "comments",
      "inbound",
      "channels",
      "channelMessages",
      "conversationEvents",
    ]);
    org2CloudSyncEngine.invalidateOrgInbound(orgId);
    bumpRemoteSessionsVersion(orgId);
    bumpOrgCommentsSignal(orgId);
    // Channels ride the same coarse net: a shadowed per-kind signal (or a
    // plain-0005 backend) must still converge the sidebar list here — this
    // is the only recovery path short of a reconnect edge.
    bumpChannelsVersion(orgId);
    // Same reasoning for the open channel transcript: a shadowed per-kind
    // signal must still converge the message list here.
    bumpChannelMessagesVersion(orgId);
    // Open conversation streams converge here too: a turn-plane append
    // broadcast while the socket was down must still be pulled on the
    // reconnect edge — the per-conversation after_seq pull is bounded.
    bumpConversationPlaneVersion(orgId);
    maybeRefreshControlPlane(orgId);
  }, [
    activeRealtimeOrgId,
    bumpRemoteSessionsVersion,
    bumpOrgCommentsSignal,
    bumpChannelsVersion,
    bumpChannelMessagesVersion,
    bumpConversationPlaneVersion,
    maybeRefreshControlPlane,
  ]);
  // Per-plane leading/trailing coalescer. A successful subscribe edge marks
  // the initial recovery as handled, so the next real server signal waits at
  // most the short live window rather than the old 60-second throttle.
  const schedulePlaneSignalRefresh = useCallback(
    (plane: SignalPlane, refresh: () => void, windowMs?: number) => {
      signalCoalescerRef.current.schedule(
        plane,
        () => {
          if (isDocumentHidden()) return;
          refresh();
        },
        windowMs
      );
    },
    []
  );
  const scheduleCoarseSignalRefresh = useCallback(() => {
    // The coarse refresh is the heaviest bundle (every plane at once), and on
    // legacy backends it fires for EVERY change kind — storm window required.
    schedulePlaneSignalRefresh(
      "coarse",
      runCoarseSignalRefresh,
      STORM_SIGNAL_COALESCE_MS
    );
  }, [schedulePlaneSignalRefresh, runCoarseSignalRefresh]);
  // Slow convergence net for narrowed dispatch: one trailing full coarse
  // refresh per control-plane TTL window while signals keep arriving.
  const armCoarseSignalSafetyNet = useCallback(() => {
    if (coarseSafetyNetTimerRef.current) return;
    coarseSafetyNetTimerRef.current = setTimeout(() => {
      coarseSafetyNetTimerRef.current = null;
      runCoarseSignalRefresh();
    }, CONTROL_PLANE_REFRESH_THROTTLE_MS);
  }, [runCoarseSignalRefresh]);

  // Single callback for every sessions-plane schedule: the coalescer keeps
  // the FIRST-armed refresh for a pending trailing window, so all entry
  // points (db-change signals, comment broadcasts) must request the same
  // full refresh or a weaker one could swallow a stronger one's work.
  const scheduleSessionsPlaneRefresh = useCallback(
    (orgId: string) => {
      schedulePlaneSignalRefresh(
        "sessions",
        () => {
          org2CloudSyncEngine.invalidateOrgInbound(orgId);
          bumpRemoteSessionsVersion(orgId);
        },
        STORM_SIGNAL_COALESCE_MS
      );
    },
    [schedulePlaneSignalRefresh, bumpRemoteSessionsVersion]
  );

  const dispatchDbChangeSignal = useCallback(
    (orgId: string, kind: Org2CloudDbChangeKind) => {
      armCoarseSignalSafetyNet();
      if (!isDocumentHidden()) maybeRefreshControlPlane(orgId);
      switch (kind) {
        case "sessions":
          scheduleSessionsPlaneRefresh(orgId);
          return;
        case "comments":
          schedulePlaneSignalRefresh(
            "comments",
            () => {
              bumpOrgCommentsSignal(orgId);
            },
            STORM_SIGNAL_COALESCE_MS
          );
          return;
        case "projects":
        case "workItems":
          schedulePlaneSignalRefresh(
            "inbound",
            () => {
              org2CloudSyncEngine.invalidateOrgInbound(orgId);
            },
            STORM_SIGNAL_COALESCE_MS
          );
          return;
        case "roster":
          schedulePlaneSignalRefresh("roster", () => {
            bumpRosterVersion(orgId);
          });
          return;
        case "policy":
          schedulePlaneSignalRefresh("policy", () => {
            void refreshEntitlementForOrg(orgId).then((floorChanged) => {
              if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
            });
            bumpRosterVersion(orgId);
          });
          return;
        case "channels":
          schedulePlaneSignalRefresh(
            "channels",
            () => {
              bumpChannelsVersion(orgId);
            },
            STORM_SIGNAL_COALESCE_MS
          );
          return;
        case "channelMessages":
          // Live-chat delta (p_since, server-capped): the short window is a
          // deliberate latency choice, and the pull is bounded.
          schedulePlaneSignalRefresh("channelMessages", () => {
            bumpChannelMessagesVersion(orgId);
          });
          return;
        case "conversationEvents":
          // Turn-plane appends move only the open conversation streams; the
          // per-conversation after_seq pull is bounded and cheap.
          schedulePlaneSignalRefresh("conversationEvents", () => {
            bumpConversationPlaneVersion(orgId);
          });
          return;
        case "member_runtime":
          // Telemetry heartbeats only move the Team Runtime roster. Routing
          // them to their own plane keeps a teammate's 15-minute push from
          // triggering the coarse full-plane fallback on every client.
          schedulePlaneSignalRefresh("memberRuntime", () => {
            bumpMemberRuntimeVersion(orgId);
          });
          return;
      }
    },
    [
      armCoarseSignalSafetyNet,
      maybeRefreshControlPlane,
      schedulePlaneSignalRefresh,
      scheduleSessionsPlaneRefresh,
      bumpOrgCommentsSignal,
      bumpRosterVersion,
      bumpMemberRuntimeVersion,
      bumpChannelsVersion,
      bumpChannelMessagesVersion,
      bumpConversationPlaneVersion,
      refreshEntitlementForOrg,
    ]
  );

  // Recovery for missed signals on a (re)subscribed org scope. Legacy: the
  // signal channel's SUBSCRIBED edge. 0005: the org broadcast channel's edge.
  const runSignalEdgeRecovery = useCallback(
    (orgId: string) => {
      // Hidden check FIRST: an edge that races a visibility flip must not
      // stamp the control-plane throttle or mark the coalescer handled while
      // skipping the actual refreshes — that claimed a recovery that never
      // ran and muted the next real one for up to the 5-min window.
      if (isDocumentHidden()) return;
      signalCoalescerRef.current.markHandled(ALL_SIGNAL_PLANES);
      controlPlaneRefreshAtRef.current = Date.now();
      // Broadcast signals are at-most-once: a frame lost with no follow-up
      // signal would otherwise never arm any convergence path. One trailing
      // coarse refresh per control-plane window bounds that staleness.
      armCoarseSignalSafetyNet();
      // A LONG gap forces complete listings so tombstone-free absences
      // (revoked projects / retention shifts) are observed; a short gap or
      // a rejoin storm keeps the delta cursors, which already merge
      // deletedAt/LWW tombstones.
      const decision = decideSubscribedEdgeRecovery({
        nowMs: Date.now(),
        teardownAtMs: orgTeardownAtRef.current.get(orgId),
        lastFullRecoveryAtMs: orgFullRecoveryAtRef.current.get(orgId),
      });
      if (decision === "delta") {
        org2CloudSyncEngine.invalidateOrgInbound(orgId);
        bumpRemoteSessionsVersion(orgId);
        bumpOrgCommentsSignal(orgId);
        bumpChannelsVersion(orgId);
        bumpChannelMessagesVersion(orgId);
        return;
      }
      orgFullRecoveryAtRef.current.set(orgId, Date.now());
      org2CloudSyncEngine.invalidateOrgInbound(orgId, {
        full: true,
        pushSessions: true,
      });
      void refreshEntitlementForOrg(orgId).then((floorChanged) => {
        if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
      });
      // Force a complete listing after a disconnected window while the
      // last authorized snapshot stays visible. The fetch coordinator
      // replaces it atomically only if the server truth changed.
      bumpRemoteSessionsVersion(orgId, { full: true });
      bumpOrgCommentsSignal(orgId);
      // The org-level bump above is TTL-gated; the session broadcast the
      // released socket missed is exactly what the open thread needs, so
      // force the active session's thread past the TTL.
      bumpActiveSessionCommentsSignal(orgId);
      // Channel lifecycle broadcasts missed while disconnected re-pull here
      // (the list RPC is a single bounded read; no delta cursor to preserve).
      bumpChannelsVersion(orgId);
      // Messages posted/edited/deleted during the gap arrive through the
      // channel's own `p_since` delta, which already carries tombstones.
      bumpChannelMessagesVersion(orgId);
    },
    [
      armCoarseSignalSafetyNet,
      bumpRemoteSessionsVersion,
      bumpOrgCommentsSignal,
      bumpActiveSessionCommentsSignal,
      bumpChannelsVersion,
      bumpChannelMessagesVersion,
      refreshEntitlementForOrg,
    ]
  );

  // --- Slice B: change-signal + roster subscriptions for the active org only.
  // Inactive orgs catch up immediately when selected; they must not keep
  // reconnecting channels or pulling data while the user works elsewhere.
  // On 0005 backends both planes ride the org broadcast channel (Slice C)
  // instead and this effect keeps only the teardown bookkeeping.
  useEffect(() => {
    const connection = connectionRef.current;
    if (!connection || !userId || !activeRealtimeOrgId) return undefined;

    const unsubscribes: Array<() => void> = [];
    const orgTeardownAt = orgTeardownAtRef.current;
    const signalCoalescer = signalCoalescerRef.current;
    const orgId = activeRealtimeOrgId;
    if (!broadcastSignals) {
      unsubscribes.push(
        connection.subscribe({
          table: CHANGE_SIGNALS_TABLE,
          filter: `org_id=eq.${orgId}`,
          onChange: () => {
            // This row carries no plane/entity discriminator. Treat it only as
            // a bounded durable event; plane-specific Presence broadcasts
            // keep normal session/comment/control changes immediate.
            scheduleCoarseSignalRefresh();
          },
          onStatus: (subscribed) => {
            // On (re)subscribe compensate for events missed while
            // disconnected.
            if (subscribed) runSignalEdgeRecovery(orgId);
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
    }

    return () => {
      for (const unsub of unsubscribes) unsub();
      orgTeardownAt.set(orgId, Date.now());
      setRosterRealtimeConnected((current) => {
        if (!(orgId in current)) return current;
        const next = { ...current };
        delete next[orgId];
        return next;
      });
      signalCoalescer.reset();
      if (coarseSafetyNetTimerRef.current) {
        clearTimeout(coarseSafetyNetTimerRef.current);
        coarseSafetyNetTimerRef.current = null;
      }
    };
    // Connection identity follows the same activeRealtimeOrgId key in Slice A.
  }, [
    activeRealtimeOrgId,
    userId,
    endpointUrl,
    broadcastSignals,
    bumpRosterVersion,
    scheduleCoarseSignalRefresh,
    runSignalEdgeRecovery,
    setRosterRealtimeConnected,
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
  useEffect(() => {
    viewingRef.current = viewing;
  }, [viewing]);

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
        if (event === ORG_DB_CHANGED_EVENT) {
          // Server-originated signal (0005 Broadcast-from-Database),
          // dispatched per kind: 0006 debounces per (org, kind) — no kind
          // shadowing — and a member-floor RPC emits BOTH 'policy' and
          // 'roster', so each kind maps to exactly its own plane refresh.
          // A plain-0005 backend still debounces per org, where a burst can
          // shadow one kind behind another and starve that plane forever
          // under narrowed dispatch. There is no capability flag for the
          // per-kind debounce, so every kind also arms a slow trailing full
          // coarse refresh (control-plane TTL cadence): a shadowed plane
          // converges within 5 minutes instead of never.
          if (!broadcastSignals) return;
          const kind = parseOrgDbChangeKind(payload);
          if (!kind) {
            // A kind this build does not know (a newer backend's plane):
            // fall back to the coarse refresh instead of total silence, so
            // an unrecognized plane still converges (Layer-5 default).
            scheduleCoarseSignalRefresh();
            return;
          }
          dispatchDbChangeSignal(orgId, kind);
          return;
        }
        if (event === ORG_CONTROL_CHANGED_EVENT) {
          const kind = parseOrgControlChangeKind(payload);
          if (kind && isDocumentHidden()) return;
          if (kind === "entitlement") {
            void refreshEntitlementForOrg(orgId).then((floorChanged) => {
              if (floorChanged) org2CloudSyncEngine.resumeOrg(orgId);
            });
          } else if (kind === "roster") {
            void refetchRef.current();
          } else if (kind === "scopes") {
            org2CloudSyncEngine.resumeOrg(orgId);
          } else if (kind === "sessions") {
            // Sent after EVERY successful peer push (250ms sender collapse
            // only) — a streaming teammate makes this a per-push storm, so
            // it must ride the same coalesced plane as the server signal.
            scheduleSessionsPlaneRefresh(orgId);
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
        if (isDocumentHidden()) return;
        // The open thread stays live; the listing (comment/task counters)
        // rides the coalesced sessions plane so a comment storm cannot
        // re-list the org per broadcast.
        setCommentsSignal((current) =>
          bumpCommentsSignalKey(current, sessionCommentsKey(orgId, sessionId))
        );
        scheduleSessionsPlaneRefresh(orgId);
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
      onStatus: (subscribed) => {
        // On 0005 backends this channel carries the change signals, so its
        // edges own the roster-connected indicator and the missed-signal
        // recovery that the dedicated legacy channels' edges owned.
        if (!broadcastSignals) return;
        setRosterRealtimeConnected((current) =>
          current[orgId] === subscribed
            ? current
            : { ...current, [orgId]: subscribed }
        );
        // `org2CloudRealtimeClient` logs CHANNEL_ERROR/TIMED_OUT with the raw
        // status while suppressing normal CLOSED teardown. Do not duplicate
        // that diagnostic here from the lossy boolean edge.
        if (!subscribed) return;
        // The 0005 path previously logged NOTHING on success — "is realtime
        // up" was unanswerable from logs (legacy postgres_changes logs its
        // subscribe at the same spot). One line per true-edge, like legacy.
        log.info(
          `realtime: org broadcast channel subscribed for active org ${orgId}`
        );
        bumpRosterVersion(orgId);
        runSignalEdgeRecovery(orgId);
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
  }, [
    activeRealtimeOrgId,
    userId,
    endpointUrl,
    broadcastSignals,
    buildPayload,
    setPresence,
    setOutboundPresence,
    setCommentsSignal,
    bumpRemoteSessionsVersion,
    scheduleSessionsPlaneRefresh,
    bumpRosterVersion,
    dispatchDbChangeSignal,
    scheduleCoarseSignalRefresh,
    runSignalEdgeRecovery,
    refreshEntitlementForOrg,
    setRosterRealtimeConnected,
  ]);

  // Keep awareness attached to the session while this foreground lease owns
  // the active org channel. Blur/visibility teardown removes the entire
  // channel and its Presence meta; navigation updates only the payload within
  // a held lease.
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
