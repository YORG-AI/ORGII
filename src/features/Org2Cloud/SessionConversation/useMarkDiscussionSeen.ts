import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { activeSessionIdAtom } from "@src/store/session";

import type { SessionCommentsContextValue } from "../SessionComments/SessionCommentsContext";
import { countLiveComments } from "../org2CloudSessionCommentsAtom.commentTransforms";
import type { GroupedCommentThreads } from "../org2CloudSessionCommentsAtom.types";
import type { ConversationFamilyMember } from "./continuationEvents";
import {
  type DiscussionSeenCounts,
  discussionSeenCountsAtom,
  discussionSeenKey,
  ratchetSeenCounts,
} from "./discussionSeenAtom";

function countGroupedLiveComments(grouped: GroupedCommentThreads): number {
  let count = countLiveComments(grouped.sessionLevel);
  count += countLiveComments(grouped.orphaned);
  for (const threads of grouped.byEventId.values()) {
    count += countLiveComments(threads);
  }
  return count;
}

/**
 * Stamp the local seen watermark while the conversation is open. Two
 * sources, max-merged: the fetched discussion itself (fresh the instant a
 * realtime comment lands in the open surface) and each family row's
 * server-side counter (covers legacy comments still sitting on fork rows
 * from before family rerooting).
 *
 * Gated on the session being the globally ACTIVE one: a conversation kept
 * in a background tab stays mounted and keeps receiving realtime rows, and
 * without the gate those arrivals would be stamped "seen" while nobody is
 * reading them — the badge would never fire.
 */
export function useMarkDiscussionSeen(
  sessionId: string,
  comments: SessionCommentsContextValue | null,
  family: readonly ConversationFamilyMember[] | null
): void {
  const setSeenCounts = useSetAtom(discussionSeenCountsAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const isActive = activeSessionId === sessionId;
  const target = comments?.target ?? null;
  const state = comments?.state;
  const grouped = comments?.grouped ?? null;

  useEffect(() => {
    if (!isActive || !target || state !== "ready" || !grouped) return;
    const updates: DiscussionSeenCounts = {
      [discussionSeenKey(target.orgId, target.sessionId)]:
        countGroupedLiveComments(grouped),
    };
    for (const member of family ?? []) {
      const key = discussionSeenKey(member.row.orgId, member.bareSessionId);
      const count = member.row.commentCount ?? 0;
      if ((updates[key] ?? 0) < count) updates[key] = count;
    }
    setSeenCounts((previous) => ratchetSeenCounts(previous, updates));
  }, [isActive, target, state, grouped, family, setSeenCounts]);
}
