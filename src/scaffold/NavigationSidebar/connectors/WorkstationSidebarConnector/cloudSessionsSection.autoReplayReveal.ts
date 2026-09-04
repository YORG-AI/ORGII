/**
 * Auto-replay half of a cloud reveal request for `cloudSessionsSection`.
 *
 * An in-app session reference (chip in a GitHub issue, a PR body, a chat
 * message) asks for the transcript itself, not just a highlighted sidebar
 * row, so its reveal request carries `autoReplay`. This module watches the
 * RAW reveal atom rather than the connector's active-session-gated
 * projection: a teammate row's local id is `imported-session-<hash>`, never
 * the source session id the request names, so the gated projection is null
 * for exactly the case this feature exists to serve.
 *
 * Four consequences of that, each handled below:
 *
 * - The request is never cleared, so it stays resident. Replay is a
 *   download: the consumed request id is a monotonic high-water mark, READ
 *   FROM THE STORE at effect time rather than from a captured render value,
 *   because two sidebar connectors are mounted at once whenever the hover
 *   sidebar is open and both would otherwise act on the same request.
 * - A resident request must also expire, or an org switch an hour later
 *   fires a replay nobody asked for.
 * - `state === "ready"` is NOT freshness: a revalidation keeps the previous
 *   rows and that state on purpose, and an org the viewer is not scoped to
 *   receives no realtime invalidations at all. Reporting "not found" off a
 *   cached listing would reject exactly the new session a reference is most
 *   likely to point at, so absence first spends one forced refresh and is
 *   only believed once a fetch that started after it has landed.
 * - `rows` is the unfiltered listing, which includes the viewer's own
 *   current-device rows that every rendered path drops. Replaying one would
 *   import a read-only copy of a live local session and hide the original.
 */
import { atom, useAtomValue, useStore } from "jotai";
import { useEffect } from "react";

import { parseCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import type { CloudSessionBusyEntry } from "@src/features/Org2Cloud/cloudSessionBusyAtom";
import type { CloudRemoteSessionsFetchState } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import {
  type SessionSidebarRevealRequest,
  requestSessionSidebarRevealAtom,
  sessionSidebarRevealRequestAtom,
} from "@src/store/ui/sidebarAtom";

/** How long an unserved autoReplay request stays honourable. */
export const AUTO_REPLAY_REQUEST_TTL_MS = 120_000;

const cloudAutoReplayConsumedRequestIdAtom = atom(0);
cloudAutoReplayConsumedRequestIdAtom.debugLabel =
  "cloudAutoReplayConsumedRequestIdAtom";

interface CloudAutoReplayProbe {
  requestId: number;
  /** `fetchedAt` observed when the forced refresh was asked for. */
  fetchedAt: number;
}

const cloudAutoReplayProbeAtom = atom<CloudAutoReplayProbe | null>(null);
cloudAutoReplayProbeAtom.debugLabel = "cloudAutoReplayProbeAtom";

export type CloudAutoReplaySkipReason = "not-found" | "not-replayable";

type CloudAutoReplayDecision =
  | { kind: "replay"; requestId: number; row: RemoteTeammateSessionMetadata }
  | { kind: "reveal-local"; requestId: number; sessionId: string }
  | {
      /** The referenced row is already downloading: refocus its surface. */
      kind: "focus-busy";
      requestId: number;
      row: RemoteTeammateSessionMetadata;
      localSessionId?: string;
    }
  | { kind: "refresh"; requestId: number; fetchedAt: number }
  | { kind: "skip"; requestId: number; reason: CloudAutoReplaySkipReason }
  | null;

export interface CloudAutoReplayInput {
  request: SessionSidebarRevealRequest | null;
  orgId: string | null;
  consumedRequestId: number;
  probe: CloudAutoReplayProbe | null;
  rows: readonly RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  fetchedAt: number;
  busySessionRows: ReadonlyMap<string, CloudSessionBusyEntry>;
  selfUserId: string | null;
  localOwnSessionIds: ReadonlySet<string>;
  nowMs: number;
}

/**
 * Decide what an autoReplay reveal should do THIS render. Returning null
 * means "not yet": the org switch, the listing fetch, or an in-flight
 * action has not settled, and a later render will decide again.
 */
export function decideCloudAutoReplay({
  request,
  orgId,
  consumedRequestId,
  probe,
  rows,
  state,
  fetchedAt,
  busySessionRows,
  selfUserId,
  localOwnSessionIds,
  nowMs,
}: CloudAutoReplayInput): CloudAutoReplayDecision {
  if (!request?.autoReplay) return null;
  if (request.requestId <= consumedRequestId) return null;
  if (nowMs - request.issuedAt > AUTO_REPLAY_REQUEST_TTL_MS) return null;
  if (!orgId || request.cloudOrgId !== orgId) return null;

  const parsed = request.sidebarItemId
    ? parseCloudRemoteItemId(request.sidebarItemId)
    : null;
  if (!parsed || parsed.orgId !== orgId) return null;

  // Busy-ness is per row: an unrelated in-flight download must not defer
  // this reference. The referenced row itself being busy means the download
  // the reference wants is already running — refocus it, consume the request.
  const targetBusy = busySessionRows.get(parsed.rowId);
  if (targetBusy) {
    const busyRow = rows.find((candidate) => candidate.id === parsed.rowId);
    if (!busyRow) return null;
    return {
      kind: "focus-busy",
      requestId: request.requestId,
      row: busyRow,
      localSessionId: targetBusy.localSessionId,
    };
  }

  const row = rows.find((candidate) => candidate.id === parsed.rowId);
  if (!row) {
    // No listing has ever landed for this org: the initial fetch decides.
    if (state !== "ready") return null;
    // A cached listing predating the reference must not be believed. Spend
    // one refresh, then judge absence against a fetch that saw the share.
    if (probe?.requestId !== request.requestId) {
      return { kind: "refresh", requestId: request.requestId, fetchedAt };
    }
    if (fetchedAt > probe.fetchedAt) {
      return {
        kind: "skip",
        requestId: request.requestId,
        reason: "not-found",
      };
    }
    return null;
  }

  // The viewer's own row, with the session already writable on this device.
  if (
    selfUserId &&
    row.ownerUserId === selfUserId &&
    localOwnSessionIds.has(row.sourceSessionId)
  ) {
    return {
      kind: "reveal-local",
      requestId: request.requestId,
      sessionId: row.sourceSessionId,
    };
  }

  if (row.deletedAt || row.eventsEpoch === undefined) {
    return {
      kind: "skip",
      requestId: request.requestId,
      reason: "not-replayable",
    };
  }
  return { kind: "replay", requestId: request.requestId, row };
}

interface UseCloudSessionAutoReplayRevealParams {
  orgId: string | null;
  rows: readonly RemoteTeammateSessionMetadata[];
  state: CloudRemoteSessionsFetchState;
  fetchedAt: number;
  busySessionRows: ReadonlyMap<string, CloudSessionBusyEntry>;
  selfUserId: string | null;
  localOwnSessionIds: ReadonlySet<string>;
  refresh: () => void;
  runReplay: (row: RemoteTeammateSessionMetadata) => void;
  /**
   * Open the viewer's own local session. A bare sidebar reveal is not
   * enough here: the chip's contract is "take me to this transcript", and
   * the highlight path is gated on the session already being active.
   */
  onRevealLocal: (sessionId: string) => void;
  /** The referenced row is already downloading — refocus its surface. */
  onFocusBusy: (
    row: RemoteTeammateSessionMetadata,
    localSessionId?: string
  ) => void;
  onSkip: (reason: CloudAutoReplaySkipReason) => void;
}

export function useCloudSessionAutoReplayReveal({
  orgId,
  rows,
  state,
  fetchedAt,
  busySessionRows,
  selfUserId,
  localOwnSessionIds,
  refresh,
  runReplay,
  onRevealLocal,
  onFocusBusy,
  onSkip,
}: UseCloudSessionAutoReplayRevealParams): void {
  const store = useStore();
  const request = useAtomValue(sessionSidebarRevealRequestAtom);

  useEffect(() => {
    // Store reads, not captured values: the second mounted connector runs
    // this effect in the same commit and must see the first one's writes.
    const decision = decideCloudAutoReplay({
      request,
      orgId,
      consumedRequestId: store.get(cloudAutoReplayConsumedRequestIdAtom),
      probe: store.get(cloudAutoReplayProbeAtom),
      rows,
      state,
      fetchedAt,
      busySessionRows,
      selfUserId,
      localOwnSessionIds,
      nowMs: Date.now(),
    });
    if (!decision) return;

    if (decision.kind === "refresh") {
      store.set(cloudAutoReplayProbeAtom, {
        requestId: decision.requestId,
        fetchedAt: decision.fetchedAt,
      });
      refresh();
      return;
    }

    store.set(cloudAutoReplayConsumedRequestIdAtom, decision.requestId);
    if (decision.kind === "replay") {
      runReplay(decision.row);
      return;
    }
    if (decision.kind === "focus-busy") {
      onFocusBusy(decision.row, decision.localSessionId);
      return;
    }
    if (decision.kind === "reveal-local") {
      store.set(requestSessionSidebarRevealAtom, {
        sessionId: decision.sessionId,
      });
      onRevealLocal(decision.sessionId);
      return;
    }
    onSkip(decision.reason);
  }, [
    busySessionRows,
    fetchedAt,
    localOwnSessionIds,
    onFocusBusy,
    onRevealLocal,
    onSkip,
    orgId,
    refresh,
    request,
    rows,
    runReplay,
    selfUserId,
    state,
    store,
  ]);
}
