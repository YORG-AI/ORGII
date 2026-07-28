import { describe, expect, it } from "vitest";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import { partitionDiscussionTimeline } from "../discussionTimelineModel";
import type { TimelineEntry } from "../types";

function entry(
  id: string,
  type: TimelineEntry["type"],
  overrides: Partial<TimelineEntry> = {}
): TimelineEntry {
  return {
    id,
    type,
    timestamp: `2026-07-28T10:0${id.length}:00.000Z`,
    userName: "Ada",
    descriptions: [id],
    ...overrides,
  };
}

describe("partitionDiscussionTimeline", () => {
  it("preserves human comments as discussion and routes changes to history", () => {
    const comment = entry("comment", WORK_ITEM_HISTORY_ACTION.COMMENTED);
    const update = entry("update", WORK_ITEM_HISTORY_ACTION.UPDATED);
    const moved = entry("moved", WORK_ITEM_HISTORY_ACTION.MOVED);

    expect(partitionDiscussionTimeline([update, comment, moved])).toEqual({
      discussionEntries: [comment],
      activityEntries: [update, moved],
    });
  });

  it("keeps delegation lifecycle comments in system activity", () => {
    const delegation = entry("delegation", WORK_ITEM_HISTORY_ACTION.COMMENTED, {
      actorId: "os-agent",
      userName: "os-agent",
      descriptions: ["Delegation started for reviewer"],
    });

    expect(partitionDiscussionTimeline([delegation])).toEqual({
      discussionEntries: [],
      activityEntries: [delegation],
    });
  });

  it("classifies a resolved agent display name by stable actor id", () => {
    const delegation = entry("delegation", WORK_ITEM_HISTORY_ACTION.COMMENTED, {
      actorId: "os-agent",
      userName: "ORGII Agent",
      descriptions: ["Delegation returned for revision"],
    });

    expect(partitionDiscussionTimeline([delegation])).toEqual({
      discussionEntries: [],
      activityEntries: [delegation],
    });
  });

  it("does not classify a human named like the legacy agent when actor id differs", () => {
    const humanComment = entry(
      "human-agent-name",
      WORK_ITEM_HISTORY_ACTION.COMMENTED,
      {
        actorId: "member-ada",
        userName: "os-agent",
        descriptions: ["Delegation is the topic of this comment"],
      }
    );

    expect(partitionDiscussionTimeline([humanComment])).toEqual({
      discussionEntries: [humanComment],
      activityEntries: [],
    });
  });
});
