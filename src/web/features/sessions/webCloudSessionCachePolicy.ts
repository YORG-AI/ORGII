import type { Org2CloudAuthState } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudAuthIdentityKey } from "@src/features/Org2Cloud/org2CloudAuthAtom";

import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import type { WebSessionListItem } from "./useWebSessionRoster";

export function buildWebCloudSessionCacheKey(
  auth: Pick<Org2CloudAuthState, "supabaseUrl" | "userId">,
  session: Pick<WebSessionListItem, "orgId" | "id">
): string {
  return `${org2CloudAuthIdentityKey(auth)}|${session.orgId}|${session.id}`;
}

/**
 * Returns true when roster summary metadata matches the cached snapshot.
 * When the roster omits segment summary fields, treat the cache as usable.
 */
export function isWebCloudSessionCacheFresh(
  session: Pick<
    WebSessionListItem,
    "eventsEpoch" | "eventsFrozenSeq" | "eventsCount" | "eventsTailHash"
  >,
  snapshot: CloudSessionEventSnapshot
): boolean {
  if (session.eventsEpoch === undefined) return true;
  if (session.eventsEpoch !== snapshot.epoch) return false;
  if (
    session.eventsFrozenSeq !== undefined &&
    session.eventsFrozenSeq !== snapshot.frozenSeq
  ) {
    return false;
  }
  if (
    session.eventsCount !== undefined &&
    session.eventsCount !== snapshot.count
  ) {
    return false;
  }
  if (
    session.eventsTailHash !== undefined &&
    session.eventsTailHash !== snapshot.tailHash
  ) {
    return false;
  }
  return true;
}

export function shouldFetchWebCloudSessionEvents(
  forceFull: boolean,
  cached: CloudSessionEventSnapshot | null,
  session: WebSessionListItem
): boolean {
  if (forceFull) return true;
  if (!cached) return true;
  return !isWebCloudSessionCacheFresh(session, cached);
}
