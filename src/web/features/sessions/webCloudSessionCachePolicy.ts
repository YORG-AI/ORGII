import type { Org2CloudAuthState } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudAuthIdentityKey } from "@src/features/Org2Cloud/org2CloudAuthAtom";

import type { CloudSessionEventSnapshot } from "./cloudSessionSegments";
import type { WebSessionListItem } from "./useWebSessionRoster";

export function buildWebCloudSessionCacheKey(
  auth: Pick<Org2CloudAuthState, "supabaseUrl" | "userId">,
  session: Pick<WebSessionListItem, "orgId" | "id">
): string {
  return buildWebCloudSessionCacheKeyForIdentity(
    org2CloudAuthIdentityKey(auth),
    session
  );
}

/** Build an eviction key from an already-captured auth identity. */
export function buildWebCloudSessionCacheKeyForIdentity(
  identityKey: string,
  session: Pick<WebSessionListItem, "orgId" | "id">
): string {
  return `${identityKey}|${session.orgId}|${session.id}`;
}

/**
 * The listing adapter removes segment summary metadata when the viewer may
 * only see session metadata. Treat that omission as an authorization boundary,
 * not as an old-client cache compatibility signal.
 */
export function canReadWebCloudSessionEvents(
  session: Pick<WebSessionListItem, "accessMode" | "eventsEpoch">
): boolean {
  return (
    session.accessMode !== "metadata_only" && session.eventsEpoch !== undefined
  );
}

/**
 * Returns true when roster summary metadata matches the cached snapshot.
 * An omitted epoch means the current viewer is not authorized to read events.
 */
export function isWebCloudSessionCacheFresh(
  session: Pick<
    WebSessionListItem,
    "eventsEpoch" | "eventsFrozenSeq" | "eventsCount" | "eventsTailHash"
  >,
  snapshot: CloudSessionEventSnapshot
): boolean {
  if (session.eventsEpoch === undefined) return false;
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
  if (!canReadWebCloudSessionEvents(session)) return false;
  if (forceFull) return true;
  if (!cached) return true;
  return !isWebCloudSessionCacheFresh(session, cached);
}
