/**
 * Realtime invalidation state for org channels. The `channels` DB-change
 * signal (0014) bumps the per-org version; `useOrgChannels` refetches on the
 * bump. Server-owned data itself lives in hook state (the
 * `useTeamRuntimeRoster` shape), keyed on `org2CloudAuthIdentityKey`, so an
 * identity switch never leaks one account's channel list into another's.
 */
import { atom } from "jotai";

export const org2CloudChannelsVersionAtom = atom<Record<string, number>>({});
org2CloudChannelsVersionAtom.debugLabel = "org2CloudChannelsVersionAtom";

/** Write-only bump used by the realtime dispatch and by mutation flows. */
export const bumpOrg2CloudChannelsVersionAtom = atom(
  null,
  (get, set, orgId: string) => {
    const current = get(org2CloudChannelsVersionAtom);
    set(org2CloudChannelsVersionAtom, {
      ...current,
      [orgId]: (current[orgId] ?? 0) + 1,
    });
  }
);
bumpOrg2CloudChannelsVersionAtom.debugLabel =
  "bumpOrg2CloudChannelsVersionAtom";

// ---------------------------------------------------------------------------
// Message plane
// ---------------------------------------------------------------------------

/**
 * Realtime invalidation for channel MESSAGES, one counter per scope. The
 * realtime `channelMessages` signal carries the org but not the channel, so
 * the map holds BOTH granularities — a bare `orgId` key for org-wide bumps
 * and an `orgId|channelId` key for targeted ones — and a reader sums them.
 * Summing avoids the alternative (registering every open channel in the map
 * on mount just so an org-wide bump has something to increment).
 */
export const org2CloudChannelMessagesVersionAtom = atom<Record<string, number>>(
  {}
);
org2CloudChannelMessagesVersionAtom.debugLabel =
  "org2CloudChannelMessagesVersionAtom";

export function channelMessagesVersionKey(
  orgId: string,
  channelId: string
): string {
  return `${orgId}|${channelId}`;
}

/** Monotonic invalidation counter for one channel's message list. */
export function selectChannelMessagesVersion(
  versions: Record<string, number>,
  orgId: string,
  channelId: string
): number {
  return (
    (versions[orgId] ?? 0) +
    (versions[channelMessagesVersionKey(orgId, channelId)] ?? 0)
  );
}

/**
 * Bump write-atom. Omit `channelId` (the realtime dispatch does) to invalidate
 * every channel of the org; pass it to invalidate exactly one.
 */
export const bumpOrg2CloudChannelMessagesVersionAtom = atom(
  null,
  (get, set, target: { orgId: string; channelId?: string }) => {
    const current = get(org2CloudChannelMessagesVersionAtom);
    const key = target.channelId
      ? channelMessagesVersionKey(target.orgId, target.channelId)
      : target.orgId;
    set(org2CloudChannelMessagesVersionAtom, {
      ...current,
      [key]: (current[key] ?? 0) + 1,
    });
  }
);
bumpOrg2CloudChannelMessagesVersionAtom.debugLabel =
  "bumpOrg2CloudChannelMessagesVersionAtom";
