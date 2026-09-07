import {
  CONVERSATION_SENDER_ARG,
  type ConversationSenderStamp,
} from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import { scopedNativeSourceEventIdOf } from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { stripCopyEventNamespace } from "@src/features/TeamCollaboration/copyEventId";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudSessionThread,
  buildCloudSessionThreads,
} from "../cloudSessionThreads";

export interface ConversationFamilyMember {
  bareSessionId: string;
  row: RemoteTeammateSessionMetadata;
  isRoot: boolean;
}

const MATERIALIZED_TURN_PREFIX = "org2-turn-v1.";
const MATERIALIZED_EVENT_PREFIX = "org2-native-v1.";

interface MaterializedEventIdentity {
  sourceEventId: string;
  turnId?: string;
}

function decodeBase64Url(value: string): string | null {
  try {
    const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat(
      (4 - (value.length % 4)) % 4
    )}`;
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0)
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function materializedEventIdentity(
  rawEventId: string
): MaterializedEventIdentity | null {
  const eventId = rawEventId.startsWith("user-message-")
    ? rawEventId.slice("user-message-".length)
    : rawEventId;
  if (eventId.startsWith(MATERIALIZED_TURN_PREFIX)) {
    const [turn, source] = eventId
      .slice(MATERIALIZED_TURN_PREFIX.length)
      .split(".", 2);
    const turnId = decodeBase64Url(turn ?? "");
    const sourceEventId = decodeBase64Url(source ?? "");
    return turnId && sourceEventId ? { sourceEventId, turnId } : null;
  }
  if (eventId.startsWith(MATERIALIZED_EVENT_PREFIX)) {
    const [source] = eventId
      .slice(MATERIALIZED_EVENT_PREFIX.length)
      .split(".", 1);
    const sourceEventId = decodeBase64Url(source ?? "");
    return sourceEventId ? { sourceEventId } : null;
  }
  return null;
}

function peelCopyEventNamespaces(event: SessionEvent): string {
  let id = stripCopyEventNamespace(event.sessionId, event.id);
  for (;;) {
    const split = id.indexOf("~");
    if (split <= 0 || id.slice(0, split).includes(":")) return id;
    id = id.slice(split + 1);
  }
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
    ...(member.row.ownerDisplayName.trim()
      ? { displayName: member.row.ownerDisplayName.trim() }
      : {}),
    ...(member.row.ownerAvatarUrl
      ? { avatarUrl: member.row.ownerAvatarUrl }
      : {}),
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
  // Native materialization can renumber the provider row while preserving the
  // original globally scoped event identity in metadata. This is the same
  // source identity used by the native projection and therefore must win over
  // the local row id when family/plane segments fold copied prefixes. Raw
  // provider-local values are intentionally ignored by the helper.
  const nativeSourceId = scopedNativeSourceEventIdOf(event);
  if (nativeSourceId) return nativeSourceId;
  const id = peelCopyEventNamespaces(event);
  return materializedEventIdentity(id)?.sourceEventId ?? id;
}

/**
 * Keep the first row for each exact canonical source identity.
 *
 * This deliberately does not compare content, timestamps, roles or tool
 * payloads. Two otherwise identical rows with different source identities are
 * distinct conversation events; only a replay carrying the same durable
 * source id is a copy.
 */
export function collapseConversationSourceCopies(
  events: readonly SessionEvent[],
  seenSourceIds: Set<string> = new Set()
): SessionEvent[] {
  const fresh: SessionEvent[] = [];
  for (const event of events) {
    const sourceId = sourceEventIdOf(event);
    if (seenSourceIds.has(sourceId)) continue;
    seenSourceIds.add(sourceId);
    fresh.push(event);
  }
  return fresh;
}

/** Turn identity recovered from a native Agent row materialized by ORG2. */
export function materializedConversationTurnIdOf(
  event: SessionEvent
): string | null {
  const id = peelCopyEventNamespaces(event);
  return materializedEventIdentity(id)?.turnId ?? null;
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
 * external-history continuations, which start empty and inherit invisibly), so a
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
    // Update the shared Set while walking: one native segment can itself
    // contain the original materialized row plus a provider-renumbered replay.
    const fresh = collapseConversationSourceCopies(events, seenSourceIds);
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
