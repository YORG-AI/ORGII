/**
 * Viewer-local "last seen" watermark for conversation discussions (Slack
 * semantics): the sidebar badge shows how many Team chat messages arrived
 * since this device last had the conversation open, and opening it clears
 * the badge. Purely local — no wire, no cross-device read receipts.
 */
import { atomWithStorage } from "jotai/utils";

export type DiscussionSeenCounts = Record<string, number>;

export const discussionSeenCountsAtom = atomWithStorage<DiscussionSeenCounts>(
  "orgii:discussion-seen-v1",
  {}
);

export function discussionSeenKey(
  orgId: string,
  bareSessionId: string
): string {
  return `${orgId}:${bareSessionId}`;
}

/**
 * Seen counts only ratchet upward: comment deletion can shrink the server
 * total below the watermark, and `max(0, …)` at the read site absorbs that
 * without ever resurrecting a badge for messages already seen.
 */
export function ratchetSeenCounts(
  previous: DiscussionSeenCounts,
  updates: Readonly<DiscussionSeenCounts>
): DiscussionSeenCounts {
  let changed = false;
  const next = { ...previous };
  for (const [key, value] of Object.entries(updates)) {
    if ((next[key] ?? 0) < value) {
      next[key] = value;
      changed = true;
    }
  }
  return changed ? next : previous;
}

export function unreadDiscussionCount(
  total: number | undefined,
  seen: number | undefined
): number {
  return Math.max(0, (total ?? 0) - (seen ?? 0));
}
