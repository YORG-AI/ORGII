import { describe, expect, it } from "vitest";

import {
  countUnreadTeamInboxItems,
  countUnreadTeamInboxItemsByFilter,
  dedupeTeamInboxItems,
  filterItemKind,
  filterTeamInboxItems,
  getTeamInboxItemKey,
  groupTeamInboxItemsByRecency,
  searchTeamInboxItems,
  selectTeamInboxItems,
  sortTeamInboxItems,
  toTeamInboxNavigationIntent,
} from "../domain/selectors";
import type {
  AssignedWorkItem,
  CommentMentionItem,
  TeamInboxItem,
} from "../domain/types";

const mention = (
  overrides: Partial<CommentMentionItem> = {}
): CommentMentionItem => ({
  id: "comment-1",
  kind: "comment_mention",
  occurredAt: "2026-07-23T09:00:00.000Z",
  readAt: null,
  actor: { id: "member-1", displayName: "Ada" },
  target: {
    kind: "session_comment",
    sessionId: "session-1",
    sessionTitle: "Fix canvas preview",
    commentId: "comment-1",
    threadId: "thread-1",
    anchor: "comment-comment-1",
  },
  payload: {
    commentBody: "@you Can you review this?",
    context: "The first pass is ready.",
    commentCount: 3,
  },
  ...overrides,
});

const assignment = (
  overrides: Partial<AssignedWorkItem> = {}
): AssignedWorkItem => ({
  id: "work-item-1",
  kind: "assigned_work_item",
  occurredAt: "2026-07-23T10:00:00.000Z",
  readAt: "2026-07-23T10:05:00.000Z",
  actor: { id: "member-2", displayName: "Lin" },
  target: {
    kind: "work_item",
    projectId: "project-1",
    workItemId: "work-item-1",
  },
  payload: {
    title: "Add Team Inbox",
    status: "in_progress",
    priority: "high",
    assigneeMemberId: "member-2",
    assigneeName: "You",
    summary: "Build the reusable feature surface.",
    updatedAt: "2026-07-23T10:00:00.000Z",
  },
  ...overrides,
});

describe("Team Inbox selectors", () => {
  it("builds identity from kind and canonical id", () => {
    expect(getTeamInboxItemKey(mention())).toBe("comment_mention:comment-1");
  });

  it("dedupes repeated pages and keeps the freshest copy", () => {
    const oldCopy = mention({
      occurredAt: "2026-07-23T08:00:00.000Z",
      payload: {
        commentBody: "old",
        commentCount: 1,
      },
    });
    const freshCopy = mention({
      occurredAt: "2026-07-23T11:00:00.000Z",
      payload: {
        commentBody: "fresh",
        commentCount: 2,
      },
    });

    expect(dedupeTeamInboxItems([oldCopy, freshCopy])).toEqual([freshCopy]);
  });

  it("sorts newest first with a deterministic identity tie-breaker", () => {
    const sameTime = "2026-07-23T10:00:00.000Z";
    const items: TeamInboxItem[] = [
      assignment({ id: "z", occurredAt: sameTime }),
      mention({ id: "a", occurredAt: sameTime }),
      mention({ id: "older", occurredAt: "2026-07-22T10:00:00.000Z" }),
    ];

    expect(sortTeamInboxItems(items).map(getTeamInboxItemKey)).toEqual([
      "assigned_work_item:z",
      "comment_mention:a",
      "comment_mention:older",
    ]);
  });

  it("filters mentions and assignments without mutating the input", () => {
    const items = [mention(), assignment()];

    expect(filterTeamInboxItems(items, "mentions")).toEqual([items[0]]);
    expect(filterTeamInboxItems(items, "assigned")).toEqual([items[1]]);
    expect(filterTeamInboxItems(items, "all")).not.toBe(items);
  });

  it("dedupes, sorts, then filters through the composed selector", () => {
    const duplicate = mention({ readAt: "2026-07-23T09:10:00.000Z" });
    expect(
      selectTeamInboxItems([mention(), assignment(), duplicate], "all")
    ).toEqual([assignment(), mention()]);
  });

  it("counts unread canonical items only once", () => {
    expect(
      countUnreadTeamInboxItems([mention(), mention(), assignment()])
    ).toBe(1);
  });

  it("splits unread counts per filter and de-duplicates first", () => {
    const unreadAssignment = assignment({ id: "unread", readAt: null });
    expect(
      countUnreadTeamInboxItemsByFilter([
        mention(),
        mention(),
        assignment(),
        unreadAssignment,
      ])
    ).toEqual({ all: 2, mentions: 1, assigned: 1 });
  });

  it("returns zeroed counts for an empty inbox", () => {
    expect(countUnreadTeamInboxItemsByFilter([])).toEqual({
      all: 0,
      mentions: 0,
      assigned: 0,
    });
  });

  it("maps filters to the item kind they expose", () => {
    expect(filterItemKind("all")).toBeNull();
    expect(filterItemKind("mentions")).toBe("comment_mention");
    expect(filterItemKind("assigned")).toBe("assigned_work_item");
  });

  it("maps both targets to typed navigation intents", () => {
    expect(toTeamInboxNavigationIntent(mention())).toEqual({
      kind: "open_session_comment",
      sessionId: "session-1",
      commentId: "comment-1",
      threadId: "thread-1",
      anchor: "comment-comment-1",
    });
    expect(toTeamInboxNavigationIntent(assignment())).toEqual({
      kind: "open_work_item",
      projectId: "project-1",
      workItemId: "work-item-1",
    });
  });

  it("returns a fresh copy of all items for an empty query", () => {
    const items = [mention(), assignment()];
    expect(searchTeamInboxItems(items, "")).toEqual(items);
    expect(searchTeamInboxItems(items, "   ")).toEqual(items);
    expect(searchTeamInboxItems(items, "")).not.toBe(items);
  });

  it("matches case-insensitively across title, body, summary and people", () => {
    const items = [mention(), assignment()];
    expect(
      searchTeamInboxItems(items, "CANVAS").map(getTeamInboxItemKey)
    ).toEqual(["comment_mention:comment-1"]);
    expect(
      searchTeamInboxItems(items, "team inbox").map(getTeamInboxItemKey)
    ).toEqual(["assigned_work_item:work-item-1"]);
    expect(
      searchTeamInboxItems(items, "review").map(getTeamInboxItemKey)
    ).toEqual(["comment_mention:comment-1"]);
    expect(
      searchTeamInboxItems(items, "reusable feature").map(getTeamInboxItemKey)
    ).toEqual(["assigned_work_item:work-item-1"]);
  });

  it("returns no items when nothing matches", () => {
    expect(searchTeamInboxItems([mention(), assignment()], "zzzz")).toEqual([]);
  });

  it("buckets items into ordered recency groups relative to now", () => {
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    const DAY = 86_400_000;
    const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    const items = [
      mention({ id: "today", occurredAt: at(0) }),
      assignment({ id: "yesterday", occurredAt: at(DAY) }),
      mention({ id: "week", occurredAt: at(3 * DAY) }),
      assignment({ id: "old", occurredAt: at(30 * DAY) }),
      mention({ id: "bad", occurredAt: "not-a-date" }),
    ];

    const groups = groupTeamInboxItemsByRecency(items, now);
    expect(groups.map((group) => group.key)).toEqual([
      "today",
      "yesterday",
      "thisWeek",
      "earlier",
    ]);
    expect(groups[3]!.items.map((item) => item.id)).toEqual(["old", "bad"]);
  });

  it("omits empty recency groups and keeps input order within a group", () => {
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();
    const groups = groupTeamInboxItemsByRecency(
      [
        mention({ id: "a", occurredAt: at(0) }),
        mention({ id: "b", occurredAt: at(1000) }),
      ],
      now
    );
    expect(groups.map((group) => group.key)).toEqual(["today"]);
    expect(groups[0]!.items.map((item) => item.id)).toEqual(["a", "b"]);
  });
});
