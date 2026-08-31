import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type {
  CommentThread,
  GroupedCommentThreads,
} from "../org2CloudSessionCommentsAtom.types";
import {
  CONVERSATION_SENDER_ARG,
  type ConversationSenderStamp,
} from "./continuationEvents";

export const SESSION_DISCUSSION_EVENT = "session_discussion";

const DISCUSSION_ID_PREFIX = "session-discussion-";
const ANCHOR_EXCERPT_MAX_LENGTH = 80;

export interface DiscussionEventPayload {
  commentId: string;
  authorUserId: string;
  authorDisplayName: string | null;
  body: string;
  kind: "user" | "agent_report";
  parentId: string | null;
  editedAt: string | null;
  resolvedAt: string | null;
  /** Local-plane id of the anchored transcript event, when present. */
  anchorLocalEventId: string | null;
  /** Display excerpt of the anchored event; "earlier version" threads keep null id. */
  anchorExcerpt: string | null;
  anchorOrphaned: boolean;
  /** Account ids the author explicitly @-mentioned (team-inbox targets). */
  mentionedUserIds: string[];
}

export function discussionPayloadOf(
  event: SessionEvent
): DiscussionEventPayload | null {
  const payload = event.args?.["sessionDiscussion"];
  if (!payload || typeof payload !== "object") return null;
  return payload as DiscussionEventPayload;
}

interface DiscussionAnchor {
  localEventId: string | null;
  excerpt: string | null;
  orphaned: boolean;
}

function commentToDiscussionEvent(
  comment: CloudSessionComment,
  sessionId: string,
  anchor: DiscussionAnchor | null
): SessionEvent | null {
  if (comment.deletedAt) return null;
  const body = comment.body.trim();
  if (!body) return null;
  const payload: DiscussionEventPayload = {
    commentId: comment.id,
    authorUserId: comment.authorUserId,
    authorDisplayName: comment.authorDisplayName ?? null,
    body,
    kind: comment.kind === "agent_report" ? "agent_report" : "user",
    parentId: comment.parentId ?? null,
    editedAt: comment.editedAt ?? null,
    resolvedAt: comment.resolvedAt ?? null,
    anchorLocalEventId: anchor?.localEventId ?? null,
    anchorExcerpt: anchor?.excerpt ?? null,
    anchorOrphaned: anchor?.orphaned ?? false,
    mentionedUserIds: comment.mentionedUserIds ?? [],
  };
  const base = {
    id: `${DISCUSSION_ID_PREFIX}${comment.id}`,
    chunk_id: `${DISCUSSION_ID_PREFIX}${comment.id}`,
    sessionId,
    createdAt: comment.createdAt,
    displayText: body,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  };
  if (
    payload.kind === "user" &&
    !payload.anchorLocalEventId &&
    !payload.anchorOrphaned
  ) {
    // Plain Team chat: a first-class user message in the stream — same
    // bubble, same turn grouping, attribution via the sender stamp.
    const stamp: ConversationSenderStamp = {
      userId: comment.authorUserId,
      displayName: comment.authorDisplayName?.trim() || comment.authorUserId,
    };
    return {
      ...base,
      functionName: SESSION_DISCUSSION_EVENT,
      uiCanonical: "user_message",
      actionType: "raw",
      args: {
        sessionDiscussion: payload,
        [CONVERSATION_SENDER_ARG]: stamp,
      },
      result: { type: "user", message: { content: body, role: "user" } },
      source: "user",
    } as SessionEvent;
  }
  // Anchored threads and agent reports keep the card renderer: they carry
  // context (turn reference, agent provenance) a plain bubble cannot show.
  return {
    ...base,
    functionName: SESSION_DISCUSSION_EVENT,
    uiCanonical: SESSION_DISCUSSION_EVENT,
    actionType: "raw",
    args: { sessionDiscussion: payload },
    result: {},
    source: "system",
  } as SessionEvent;
}

function threadEvents(
  thread: CommentThread,
  sessionId: string,
  anchor: DiscussionAnchor | null
): SessionEvent[] {
  const rows: SessionEvent[] = [];
  const top = commentToDiscussionEvent(thread.top, sessionId, anchor);
  if (top) rows.push(top);
  for (const reply of thread.replies) {
    const row = commentToDiscussionEvent(reply, sessionId, null);
    if (row) rows.push(row);
  }
  return rows;
}

function anchorExcerptOf(event: SessionEvent | undefined): string | null {
  const text = event?.displayText.trim();
  if (!text) return null;
  return text.length > ANCHOR_EXCERPT_MAX_LENGTH
    ? `${text.slice(0, ANCHOR_EXCERPT_MAX_LENGTH)}…`
    : text;
}

/**
 * Flatten grouped comment threads into synthetic discussion `SessionEvent`s.
 *
 * `localEventsBySourceId` maps the source-plane anchor id each comment stores
 * back to the event in the local transcript (identity for ordinary sessions,
 * namespace-stripped for forks/imports).
 */
export function buildDiscussionEvents(
  grouped: GroupedCommentThreads,
  sessionId: string,
  localEventsBySourceId: ReadonlyMap<string, SessionEvent>
): SessionEvent[] {
  const rows: SessionEvent[] = [];
  for (const [sourceEventId, threads] of grouped.byEventId) {
    const localEvent = localEventsBySourceId.get(sourceEventId);
    const anchor: DiscussionAnchor = {
      localEventId: localEvent?.id ?? null,
      excerpt: anchorExcerptOf(localEvent),
      orphaned: false,
    };
    for (const thread of threads) {
      rows.push(...threadEvents(thread, sessionId, anchor));
    }
  }
  for (const thread of grouped.sessionLevel) {
    rows.push(...threadEvents(thread, sessionId, null));
  }
  for (const thread of grouped.orphaned) {
    rows.push(
      ...threadEvents(thread, sessionId, {
        localEventId: null,
        excerpt: null,
        orphaned: true,
      })
    );
  }
  return rows;
}

function timestampMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Interleave discussion rows into the transcript by timestamp. Ties resolve
 * transcript-first so a comment lands after the turn it reacted to.
 */
export function mergeConversationEvents(
  transcript: readonly SessionEvent[],
  discussion: readonly SessionEvent[]
): SessionEvent[] {
  if (discussion.length === 0) return [...transcript];
  const sortedDiscussion = [...discussion].sort((left, right) => {
    const delta = timestampMs(left.createdAt) - timestampMs(right.createdAt);
    if (delta !== 0) return delta;
    return left.id < right.id ? -1 : 1;
  });
  const merged: SessionEvent[] = [];
  let cursor = 0;
  for (const event of transcript) {
    const eventMs = timestampMs(event.createdAt);
    while (
      cursor < sortedDiscussion.length &&
      timestampMs(sortedDiscussion[cursor].createdAt) < eventMs
    ) {
      merged.push(sortedDiscussion[cursor]);
      cursor += 1;
    }
    merged.push(event);
  }
  while (cursor < sortedDiscussion.length) {
    merged.push(sortedDiscussion[cursor]);
    cursor += 1;
  }
  return merged;
}
