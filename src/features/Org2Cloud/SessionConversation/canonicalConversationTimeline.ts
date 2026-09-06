/**
 * The single canonical timeline projection shared by rendering and execution.
 * Provider execution may load missing family members first; the UI may add a
 * sender-local live runner overlay afterwards, but neither owns another base
 * stitch/plane/discussion merge.
 */
import type { ConversationViewerState } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import { nativeSourceEventId } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import { groupCommentThreads } from "../org2CloudSessionCommentsAtom";
import {
  type ConversationFamilyMember,
  collapseConversationSourceCopies,
  sourceEventIdOf,
  stitchConversationSegments,
} from "./continuationEvents";
import { mergePlaneIntoTranscript } from "./conversationTimeline";
import {
  buildDiscussionEvents,
  mergeConversationEvents,
} from "./discussionEvents";

export interface CanonicalConversationTimelineInput {
  family: readonly ConversationFamilyMember[] | null;
  anchorBareSessionId: string;
  anchorEvents: readonly SessionEvent[];
  eventsByBareSessionId?: ReadonlyMap<string, readonly SessionEvent[]>;
  planeEvents: readonly CloudConversationEvent[];
  /** First durable plane timestamp, even when `planeEvents` is a cached tail. */
  planeHistoryStartedAt?: string | null;
  comments: readonly CloudSessionComment[];
  streamSessionId: string;
  viewer: ConversationViewerState;
  /** Optional local-id spelling repair used by the mounted comment surface. */
  toSourceEventId?: (eventId: string) => string;
}

export const MAX_CANONICAL_FAMILY_LOAD_CONCURRENCY = 4;

function timestampMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The conversation plane owns every turn after its introduction. Fork rows
 * created later are execution episodes, not extra transcript sources. Only
 * the root/active anchor and pre-plane members participate in legacy
 * stitching; an invalid boundary fails conservatively by retaining family.
 */
export function legacyConversationFamilyForTimeline(
  family: readonly ConversationFamilyMember[] | null,
  anchorBareSessionId: string,
  planeEvents: readonly CloudConversationEvent[],
  planeHistoryStartedAt?: string | null
): readonly ConversationFamilyMember[] | null {
  if (!family || planeEvents.length === 0) return family;
  const planeStart = timestampMs(
    planeHistoryStartedAt ?? planeEvents[0]?.createdAt
  );
  if (planeStart === null) return family;
  return family.filter((member) => {
    if (member.isRoot || member.bareSessionId === anchorBareSessionId) {
      return true;
    }
    const forkedAt = timestampMs(member.row.forkedFrom?.forkedAt);
    return forkedAt === null || forkedAt <= planeStart;
  });
}

/** Assemble family, plane and Team Chat into one provider-portable prefix. */
export function assembleCanonicalConversationTimeline(
  input: CanonicalConversationTimelineInput
): SessionEvent[] {
  const legacyFamily = legacyConversationFamilyForTimeline(
    input.family,
    input.anchorBareSessionId,
    input.planeEvents,
    input.planeHistoryStartedAt
  );
  const familyBase = legacyFamily
    ? stitchConversationSegments(
        legacyFamily,
        input.anchorBareSessionId,
        input.anchorEvents,
        input.eventsByBareSessionId ?? new Map()
      )
    : collapseConversationSourceCopies(input.anchorEvents);
  const transcript =
    input.planeEvents.length > 0
      ? mergePlaneIntoTranscript(
          familyBase,
          input.planeEvents,
          input.streamSessionId,
          input.viewer
        )
      : familyBase;
  if (input.comments.length === 0) return transcript;

  const bySourceId = new Map<string, SessionEvent>();
  for (const event of transcript) {
    const sourceIds = [sourceEventIdOf(event), event.id];
    if (input.toSourceEventId) {
      sourceIds.push(input.toSourceEventId(event.id));
    }
    for (const sourceId of sourceIds) {
      if (!bySourceId.has(sourceId)) bySourceId.set(sourceId, event);
    }
  }
  const grouped = groupCommentThreads(
    input.comments,
    new Set(bySourceId.keys())
  );
  const discussion = buildDiscussionEvents(
    grouped,
    input.streamSessionId,
    bySourceId
  );
  if (discussion.length === 0) return transcript;

  // A prior native continuation can already contain the provider echo of a
  // Team Chat row. Cloud comments remain the authoritative representation
  // because they retain authorship, mentions and thread metadata; remove the
  // native echo before interleaving that same comment again. Earlier
  // family/plane collapse cannot own this invariant because discussion is
  // appended only here. Pending/failed optimistic comments are deliberately
  // excluded: they are not provider history yet and must not displace the
  // last delivered native row.
  const deliveredDiscussionIds = new Set(
    discussion
      .filter(
        (event) =>
          event.source === "user" && event.displayStatus === "completed"
      )
      .map(nativeSourceEventId)
  );
  const withoutNativeDiscussionEchoes = transcript.filter(
    (event) => !deliveredDiscussionIds.has(nativeSourceEventId(event))
  );
  return mergeConversationEvents(withoutNativeDiscussionEchoes, discussion);
}

export class CanonicalConversationFamilyUnavailableError extends Error {
  constructor(readonly bareSessionId: string) {
    super(
      `canonical conversation family member is unavailable: ${bareSessionId}`
    );
    this.name = "CanonicalConversationFamilyUnavailableError";
  }
}

interface LoadCanonicalConversationTimelineInput extends Omit<
  CanonicalConversationTimelineInput,
  "anchorEvents" | "eventsByBareSessionId"
> {
  /** null means the member should exist but is not locally recoverable yet. */
  loadMemberEvents: (
    bareSessionId: string,
    member: ConversationFamilyMember | null
  ) => Promise<readonly SessionEvent[] | null>;
}

/**
 * Load every required family segment before using the same pure assembler as
 * the UI. An execution prefix must never silently omit an available member.
 */
export async function loadCanonicalConversationTimeline(
  input: LoadCanonicalConversationTimelineInput
): Promise<SessionEvent[]> {
  const eventsByBareSessionId = new Map<string, readonly SessionEvent[]>();
  const legacyFamily = legacyConversationFamilyForTimeline(
    input.family,
    input.anchorBareSessionId,
    input.planeEvents,
    input.planeHistoryStartedAt
  );
  if (legacyFamily) {
    const anchorMember = legacyFamily.find(
      (member) => member.bareSessionId === input.anchorBareSessionId
    );
    if (!anchorMember) {
      throw new CanonicalConversationFamilyUnavailableError(
        input.anchorBareSessionId
      );
    }
    const anchorEvents = await input.loadMemberEvents(
      anchorMember.bareSessionId,
      anchorMember
    );
    if (!anchorEvents) {
      throw new CanonicalConversationFamilyUnavailableError(
        anchorMember.bareSessionId
      );
    }
    eventsByBareSessionId.set(anchorMember.bareSessionId, anchorEvents);
    const remaining = legacyFamily.filter(
      (member) => member.bareSessionId !== input.anchorBareSessionId
    );
    let cursor = 0;
    const workers = Array.from(
      {
        length: Math.min(
          MAX_CANONICAL_FAMILY_LOAD_CONCURRENCY,
          remaining.length
        ),
      },
      async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const member = remaining[index];
          if (!member) return;
          const events = await input.loadMemberEvents(
            member.bareSessionId,
            member
          );
          if (!events) {
            throw new CanonicalConversationFamilyUnavailableError(
              member.bareSessionId
            );
          }
          eventsByBareSessionId.set(member.bareSessionId, events);
        }
      }
    );
    await Promise.all(workers);
  } else {
    const events = await input.loadMemberEvents(
      input.anchorBareSessionId,
      null
    );
    if (!events) {
      throw new CanonicalConversationFamilyUnavailableError(
        input.anchorBareSessionId
      );
    }
    eventsByBareSessionId.set(input.anchorBareSessionId, events);
  }

  return assembleCanonicalConversationTimeline({
    ...input,
    anchorEvents: eventsByBareSessionId.get(input.anchorBareSessionId) ?? [],
    eventsByBareSessionId,
  });
}
