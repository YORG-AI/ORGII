import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { stripCopyEventNamespace } from "@src/features/TeamCollaboration/copyEventId";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudSessionThread,
  buildCloudSessionThreads,
} from "../cloudSessionThreads";

/** Per-event sender stamp read by UserChatItem for stitched family rows. */
export const CONVERSATION_SENDER_ARG = "conversationSender";

export interface ConversationSenderStamp {
  userId: string;
  displayName: string;
}

export interface ConversationFamilyMember {
  bareSessionId: string;
  row: RemoteTeammateSessionMetadata;
  isRoot: boolean;
}

/**
 * Ordered family for one conversation: root first, then forks by fork time.
 * `null` when the anchor session has no fork family in the org's rows.
 */
export function resolveConversationFamily(
  rows: readonly RemoteTeammateSessionMetadata[],
  anchorBareSessionId: string
): ConversationFamilyMember[] | null {
  const threads = buildCloudSessionThreads(rows);
  const thread = threads.find(
    (candidate: CloudSessionThread) =>
      candidate.root.bareSessionId === anchorBareSessionId ||
      candidate.descendants.some(
        (descendant) => descendant.bareSessionId === anchorBareSessionId
      )
  );
  if (!thread || thread.descendants.length === 0) return null;
  const forkTime = (row: RemoteTeammateSessionMetadata): number => {
    const raw = row.forkedFrom?.forkedAt ?? row.lastActivityAt;
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const descendants = [...thread.descendants].sort(
    (left, right) => forkTime(left.row) - forkTime(right.row)
  );
  return [
    {
      bareSessionId: thread.root.bareSessionId,
      row: thread.root.row,
      isRoot: true,
    },
    ...descendants.map((descendant) => ({
      bareSessionId: descendant.bareSessionId,
      row: descendant.row,
      isRoot: false,
    })),
  ];
}

function stampSegmentSender(
  events: readonly SessionEvent[],
  member: ConversationFamilyMember
): SessionEvent[] {
  const stamp: ConversationSenderStamp = {
    userId: member.row.ownerUserId,
    displayName: member.row.ownerDisplayName,
  };
  return events.map((event) =>
    event.source === "user"
      ? { ...event, args: { ...event.args, [CONVERSATION_SENDER_ARG]: stamp } }
      : event
  );
}

/**
 * Source-plane identity of a (possibly copied) event. Fork and import copies
 * namespace their event ids as `<localSessionId>~<originalId>` so the events
 * table's single-column PK stays collision-free; peeling the layers back
 * recovers the shared source id. Chains stack (a fork of an imported copy
 * wraps twice), so keep peeling while a colon-free prefix remains — raw
 * event ids carry colons, session ids never do.
 */
export function sourceEventIdOf(event: SessionEvent): string {
  let id = stripCopyEventNamespace(event.sessionId, event.id);
  for (;;) {
    const split = id.indexOf("~");
    if (split <= 0 || id.slice(0, split).includes(":")) return id;
    id = id.slice(split + 1);
  }
}

/**
 * Stitch the family into one seamless stream: root segment first, then each
 * continuation in fork order. The anchor view contributes its own transcript
 * (`anchorEvents`) for its slot; other members render from
 * `eventsByBareSessionId` when a local copy exists — their user rows are
 * stamped with the segment owner's name so attribution lives on the message,
 * not on a divider. Members without a local copy render nothing here:
 * `useEnsureFamilyLoaded` imports them in the background, so their segment
 * streams in like any arriving message.
 *
 * Native org2 forks COPY the parent transcript into the fork (unlike
 * external-history forks, which start empty and inherit invisibly), so a
 * later segment can carry duplicates of everything an earlier segment
 * already rendered — with the wrong author stamped on them. Cross-segment
 * dedup by source event id keeps only the first (correctly attributed)
 * copy; when the root has no local copy the fork's inherited rows are the
 * only copy and survive untouched.
 */
export function stitchConversationSegments(
  family: readonly ConversationFamilyMember[],
  anchorBareSessionId: string,
  anchorEvents: readonly SessionEvent[],
  eventsByBareSessionId: ReadonlyMap<string, readonly SessionEvent[]>
): SessionEvent[] {
  const stitched: SessionEvent[] = [];
  const seenSourceIds = new Set<string>();
  const pushSegment = (
    events: readonly SessionEvent[],
    member: ConversationFamilyMember
  ) => {
    const fresh = events.filter(
      (event) => !seenSourceIds.has(sourceEventIdOf(event))
    );
    for (const event of fresh) seenSourceIds.add(sourceEventIdOf(event));
    stitched.push(...stampSegmentSender(fresh, member));
  };
  for (const member of family) {
    const isAnchor = member.bareSessionId === anchorBareSessionId;
    if (isAnchor) {
      pushSegment(anchorEvents, member);
      continue;
    }
    const events = eventsByBareSessionId.get(member.bareSessionId);
    if (events) {
      pushSegment(events, member);
    }
  }
  return stitched;
}
