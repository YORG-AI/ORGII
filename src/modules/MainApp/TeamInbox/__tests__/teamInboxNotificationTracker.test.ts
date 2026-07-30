import { describe, expect, it } from "vitest";

import type { TeamInboxItem } from "../domain";
import { TeamInboxNotificationTracker } from "../teamInboxNotificationTracker";

const NOW = Date.parse("2026-07-29T08:00:00.000Z");

function assignment(
  id: string,
  occurredAt = "2026-07-29T08:00:00.000Z",
  readAt: string | null = null
): TeamInboxItem {
  return {
    id,
    kind: "assigned_work_item",
    occurredAt,
    readAt,
    actor: { id: "member-a", displayName: "Ada" },
    target: {
      kind: "work_item",
      projectId: "",
      workItemId: id,
    },
    payload: {
      title: `Work ${id}`,
      status: "open",
      priority: "medium",
      assigneeMemberId: "viewer",
      updatedAt: occurredAt,
    },
  };
}

function mention(
  id: string,
  occurredAt = "2026-07-29T08:00:00.000Z"
): TeamInboxItem {
  return {
    id,
    kind: "comment_mention",
    occurredAt,
    readAt: null,
    actor: { id: "member-b", displayName: "Lin" },
    target: {
      kind: "work_item_comment",
      projectId: "",
      workItemId: "work-1",
      commentId: id,
      workItemTitle: "Work 1",
    },
    payload: {
      commentBody: "Please review this.",
      commentCount: 1,
    },
  };
}

describe("TeamInboxNotificationTracker", () => {
  it("baselines existing unread items and only returns later arrivals", () => {
    const tracker = new TeamInboxNotificationTracker(() => NOW);
    const existing = assignment("existing", "2026-07-29T07:59:00.000Z");

    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: false,
        items: [existing],
      })
    ).toEqual([]);

    const nextAssignment = assignment(
      "new-assignment",
      "2026-07-29T08:00:01.000Z"
    );
    const nextMention = mention("new-mention", "2026-07-29T08:00:01.000Z");
    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: false,
        items: [nextMention, nextAssignment, existing],
      })
    ).toEqual([nextMention, nextAssignment]);
  });

  it("does not replay refreshes, mark-unread changes, or older load-more rows", () => {
    const tracker = new TeamInboxNotificationTracker(() => NOW);
    const existing = assignment("existing", "2026-07-29T07:59:00.000Z");
    tracker.observe({
      scopeKey: "viewer::org-a",
      loading: false,
      items: [existing],
    });

    const next = mention("new", "2026-07-29T08:00:01.000Z");
    tracker.observe({
      scopeKey: "viewer::org-a",
      loading: false,
      items: [next, existing],
    });

    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: false,
        items: [
          next,
          existing,
          assignment("old-page", "2026-07-28T08:00:00.000Z"),
        ],
      })
    ).toEqual([]);
    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: false,
        items: [next, { ...existing, readAt: null }],
      })
    ).toEqual([]);
  });

  it("establishes a fresh baseline on identity or Org switch", () => {
    const tracker = new TeamInboxNotificationTracker(() => NOW);
    tracker.observe({
      scopeKey: "viewer-a::org-a",
      loading: false,
      items: [],
    });
    expect(
      tracker.observe({
        scopeKey: "viewer-a::org-a",
        loading: false,
        items: [assignment("new", "2026-07-29T08:00:01.000Z")],
      })
    ).toHaveLength(1);

    expect(
      tracker.observe({
        scopeKey: "viewer-b::org-b",
        loading: false,
        items: [assignment("private-to-b", "2026-07-29T08:00:02.000Z")],
      })
    ).toEqual([]);
  });

  it("ignores loading placeholders until a complete baseline is ready", () => {
    const tracker = new TeamInboxNotificationTracker(() => NOW);
    const existing = assignment("existing");

    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: true,
        items: [],
      })
    ).toEqual([]);
    expect(
      tracker.observe({
        scopeKey: "viewer::org-a",
        loading: false,
        items: [existing],
      })
    ).toEqual([]);
  });
});
