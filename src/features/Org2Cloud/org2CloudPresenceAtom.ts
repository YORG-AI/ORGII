/** ORG2 Cloud org-level presence state (who is online / viewing which session), fed by useOrg2CloudRealtime. */
import { atom } from "jotai";

import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import { parseCloudOrgSelectorValue } from "./org2CloudOrgsAtom";

export interface Org2CloudPresenceEntry {
  userId: string;
  displayName: string;
  /** Bare (owner-side) session id being viewed in this org, or null. */
  viewingSessionId: string | null;
  /** Sender clock used to collapse overlapping re-track/device metas. */
  updatedAt?: number;
}

export interface Org2CloudSessionRef {
  orgId: string;
  bareSessionId: string;
}

/** orgId → userId → presence entry (last-write-wins per user key). */
export const org2CloudPresenceAtom = atom<
  Record<string, Record<string, Org2CloudPresenceEntry>>
>({});

/** Last local payload prepared for each org; useful for sync diagnostics. */
export const org2CloudPresenceOutboundAtom = atom<
  Record<
    string,
    { viewingSessionId: string | null; updatedAt: number; updateCount: number }
  >
>({});

/**
 * Presence can contain multiple metas for one user (re-track overlap or the
 * same account on several devices). Payloads carry `updatedAt`; collapse them
 * with explicit last-write-wins semantics instead of depending on array order.
 */
export function latestPresenceMeta(
  metas: Array<Record<string, unknown>>
): Record<string, unknown> {
  let latest: Record<string, unknown> = {};
  let latestUpdatedAt = Number.NEGATIVE_INFINITY;
  for (const meta of metas) {
    const candidate = Number(meta.updatedAt);
    const updatedAt = Number.isFinite(candidate) ? candidate : 0;
    if (updatedAt >= latestUpdatedAt) {
      latest = meta;
      latestUpdatedAt = updatedAt;
    }
  }
  return latest;
}

/** Other users currently viewing `bareSessionId` in `orgId`. */
export function viewersForSession(
  presence: Record<string, Record<string, Org2CloudPresenceEntry>>,
  orgId: string,
  bareSessionId: string,
  selfUserId: string | null
): Org2CloudPresenceEntry[] {
  const byUser = presence[orgId];
  if (!byUser) return [];
  return Object.values(byUser).filter(
    (entry) =>
      entry.viewingSessionId === bareSessionId && entry.userId !== selfUserId
  );
}

/**
 * Map a local session to every cloud session identity it views.
 * Replay imports view only their source; owner-side sessions can be shared
 * into more than one org through explicit session tags.
 */
export function resolveCloudSessionRefs(
  session: Session,
  taggedCloudOrgIds: readonly string[] = [],
  publishedRows: readonly Pick<
    RemoteTeammateSessionMetadata,
    "orgId" | "ownerUserId" | "sourceSessionId"
  >[] = [],
  selfUserId: string | null = null
): Org2CloudSessionRef[] {
  if (session.importedFrom?.orgId) {
    return [
      {
        orgId: session.importedFrom.orgId,
        bareSessionId: session.importedFrom.sourceSessionId,
      },
    ];
  }
  const forkedFrom = getSessionForkedFrom(session);
  if (forkedFrom?.orgId) {
    return [{ orgId: forkedFrom.orgId, bareSessionId: session.session_id }];
  }
  const refs: Org2CloudSessionRef[] = [];
  const stampedOrgId = session.orgId
    ? parseCloudOrgSelectorValue(session.orgId)
    : null;
  if (stampedOrgId) {
    refs.push({ orgId: stampedOrgId, bareSessionId: session.session_id });
  }
  for (const orgId of taggedCloudOrgIds) {
    if (refs.some((ref) => ref.orgId === orgId)) continue;
    refs.push({ orgId, bareSessionId: session.session_id });
  }
  // An org-wide minimum can publish an in-scope session without adding an
  // explicit local org tag. The server listing is then the authoritative
  // evidence that this user's local session has a cloud identity. Without
  // this bridge, the owner publishes no viewingSessionId while a teammate's
  // imported copy correctly points at the same source session.
  if (selfUserId) {
    for (const row of publishedRows) {
      if (
        row.ownerUserId !== selfUserId ||
        row.sourceSessionId !== session.session_id ||
        refs.some((ref) => ref.orgId === row.orgId)
      ) {
        continue;
      }
      refs.push({ orgId: row.orgId, bareSessionId: session.session_id });
    }
  }
  return refs;
}

/** Singular compatibility helper for sessions with one cloud identity. */
export function resolveCloudSessionRef(
  session: Session,
  taggedCloudOrgIds: readonly string[] = []
): Org2CloudSessionRef | null {
  return resolveCloudSessionRefs(session, taggedCloudOrgIds)[0] ?? null;
}
