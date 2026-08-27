import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type { GroupedCommentThreads } from "../org2CloudSessionCommentsAtom.types";
import { CONVERSATION_SENDER_ARG } from "./continuationEvents";
import {
  SESSION_DISCUSSION_EVENT,
  buildDiscussionEvents,
  discussionPayloadOf,
  mergeConversationEvents,
} from "./discussionEvents";

function comment(overrides: Partial<CloudSessionComment>): CloudSessionComment {
  return {
    id: "c-1",
    authorUserId: "user-1",
    authorDisplayName: "Alice",
    body: "looks good",
    createdAt: "2026-08-20T10:00:00Z",
    ...overrides,
  } as CloudSessionComment;
}

function transcriptEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    id: "evt-1",
    chunk_id: "evt-1",
    sessionId: "session-1",
    createdAt: "2026-08-20T09:00:00Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {},
    source: "assistant",
    displayText: "hello",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
    ...overrides,
  } as SessionEvent;
}

function grouped(
  overrides: Partial<GroupedCommentThreads>
): GroupedCommentThreads {
  return {
    byEventId: new Map(),
    sessionLevel: [],
    orphaned: [],
    ...overrides,
  };
}

describe("buildDiscussionEvents", () => {
  it("maps anchored threads with the local event excerpt and flattens replies", () => {
    const anchorEvent = transcriptEvent({
      id: "local-evt-9",
      displayText: "please refactor the auth module",
    });
    const rows = buildDiscussionEvents(
      grouped({
        byEventId: new Map([
          [
            "source-evt-9",
            [
              {
                top: comment({ id: "c-top", body: "is this safe?" }),
                replies: [
                  comment({
                    id: "c-reply",
                    parentId: "c-top",
                    body: "yes",
                    kind: "agent_report",
                    createdAt: "2026-08-20T10:05:00Z",
                  }),
                ],
              },
            ],
          ],
        ]),
      }),
      "session-1",
      new Map([["source-evt-9", anchorEvent]])
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].uiCanonical).toBe(SESSION_DISCUSSION_EVENT);
    expect(rows[0].source).toBe("system");
    const top = discussionPayloadOf(rows[0]);
    expect(top?.anchorLocalEventId).toBe("local-evt-9");
    expect(top?.anchorExcerpt).toBe("please refactor the auth module");
    const reply = discussionPayloadOf(rows[1]);
    expect(reply?.kind).toBe("agent_report");
    expect(reply?.anchorLocalEventId).toBeNull();
  });

  it("drops deleted and empty comments and marks orphaned anchors", () => {
    const rows = buildDiscussionEvents(
      grouped({
        sessionLevel: [
          {
            top: comment({ id: "c-del", deletedAt: "2026-08-20T11:00:00Z" }),
            replies: [comment({ id: "c-blank", body: "   " })],
          },
        ],
        orphaned: [
          { top: comment({ id: "c-orphan", body: "old note" }), replies: [] },
        ],
      }),
      "session-1",
      new Map()
    );

    expect(rows).toHaveLength(1);
    const payload = discussionPayloadOf(rows[0]);
    expect(payload?.commentId).toBe("c-orphan");
    expect(payload?.anchorOrphaned).toBe(true);
  });

  it("renders plain Team chat as a native user message with a sender stamp", () => {
    const rows = buildDiscussionEvents(
      grouped({
        sessionLevel: [{ top: comment({}), replies: [] }],
      }),
      "session-1",
      new Map()
    );
    expect(rows[0].source).toBe("user");
    expect(rows[0].uiCanonical).toBe("user_message");
    expect(rows[0].result["type"]).toBe("user");
    expect(rows[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "user-1",
      displayName: "Alice",
    });
  });

  it("keeps the card renderer for anchored threads and agent reports", () => {
    const rows = buildDiscussionEvents(
      grouped({
        sessionLevel: [{ top: comment({ kind: "agent_report" }), replies: [] }],
      }),
      "session-1",
      new Map()
    );
    expect(rows[0].source).toBe("system");
    expect(rows[0].uiCanonical).toBe(SESSION_DISCUSSION_EVENT);
    expect(rows[0].result["type"]).toBeUndefined();
  });
});

describe("mergeConversationEvents", () => {
  const early = transcriptEvent({
    id: "evt-early",
    createdAt: "2026-08-20T09:00:00Z",
  });
  const late = transcriptEvent({
    id: "evt-late",
    createdAt: "2026-08-20T12:00:00Z",
  });

  function discussionAt(id: string, createdAt: string): SessionEvent {
    const [row] = buildDiscussionEvents(
      grouped({
        sessionLevel: [{ top: comment({ id, createdAt }), replies: [] }],
      }),
      "session-1",
      new Map()
    );
    return row;
  }

  it("interleaves discussion rows between transcript events by timestamp", () => {
    const middle = discussionAt("c-mid", "2026-08-20T10:00:00Z");
    const trailing = discussionAt("c-tail", "2026-08-20T13:00:00Z");
    const merged = mergeConversationEvents([early, late], [trailing, middle]);
    expect(merged.map((event) => event.id)).toEqual([
      "evt-early",
      "session-discussion-c-mid",
      "evt-late",
      "session-discussion-c-tail",
    ]);
  });

  it("puts a same-timestamp discussion row after the transcript event", () => {
    const tied = discussionAt("c-tied", early.createdAt);
    const merged = mergeConversationEvents([early, late], [tied]);
    expect(merged.map((event) => event.id)).toEqual([
      "evt-early",
      "session-discussion-c-tied",
      "evt-late",
    ]);
  });

  it("returns the transcript untouched when there is no discussion", () => {
    const merged = mergeConversationEvents([early, late], []);
    expect(merged.map((event) => event.id)).toEqual(["evt-early", "evt-late"]);
  });
});
