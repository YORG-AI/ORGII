import { describe, expect, it } from "vitest";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import { groupActivityTimelineEntries } from "../activityTimelineModel";
import type { TimelineEntry } from "../types";

function updatedEntry(
  id: string,
  timestamp: string,
  overrides: Partial<TimelineEntry> = {}
): TimelineEntry {
  return {
    id,
    timestamp,
    type: WORK_ITEM_HISTORY_ACTION.UPDATED,
    actorId: "member-1",
    userName: "Ada",
    descriptions: [`change ${id}`],
    changeFields: ["status"],
    changeFieldKeys: ["status"],
    ...overrides,
  };
}

describe("activity timeline grouping", () => {
  it("groups consecutive updates from the same actor within five minutes", () => {
    const items = groupActivityTimelineEntries([
      updatedEntry("one", "2026-07-28T11:00:00Z"),
      updatedEntry("two", "2026-07-28T11:04:00Z", {
        descriptions: ["changed status", "changed priority"],
        changeFields: ["status", "priority"],
        changeFieldKeys: ["status", "priority"],
      }),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "change-group",
      id: "change-group:one:two",
      changeCount: 3,
      fieldLabels: ["status", "priority"],
      fieldKeys: ["status", "priority"],
      timestamp: "2026-07-28T11:04:00Z",
    });
    expect(
      items[0].kind === "change-group"
        ? items[0].entries.map((entry) => entry.id)
        : []
    ).toEqual(["one", "two"]);
  });

  it("keeps comments as chronological boundaries", () => {
    const items = groupActivityTimelineEntries([
      updatedEntry("one", "2026-07-28T11:00:00Z"),
      {
        id: "comment",
        timestamp: "2026-07-28T11:01:00Z",
        type: WORK_ITEM_HISTORY_ACTION.COMMENTED,
        actorId: "member-2",
        userName: "Grace",
        descriptions: ["Please review"],
      },
      updatedEntry("two", "2026-07-28T11:02:00Z"),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["entry", "entry", "entry"]);
  });

  it("does not merge different actors or updates outside the time window", () => {
    const items = groupActivityTimelineEntries([
      updatedEntry("one", "2026-07-28T11:00:00Z"),
      updatedEntry("two", "2026-07-28T11:01:00Z", {
        actorId: "member-2",
        userName: "Grace",
      }),
      updatedEntry("three", "2026-07-28T11:10:00Z", {
        actorId: "member-2",
        userName: "Grace",
      }),
    ]);

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.kind === "entry")).toBe(true);
  });

  it("fails closed for invalid or out-of-order timestamps", () => {
    const items = groupActivityTimelineEntries([
      updatedEntry("one", "2026-07-28T11:02:00Z"),
      updatedEntry("two", "not-a-timestamp"),
      updatedEntry("three", "2026-07-28T11:01:00Z"),
    ]);

    expect(items).toHaveLength(3);
    expect(items.every((item) => item.kind === "entry")).toBe(true);
  });

  it("keeps lifecycle events separate from field updates", () => {
    const items = groupActivityTimelineEntries([
      updatedEntry("one", "2026-07-28T11:00:00Z"),
      {
        id: "moved",
        timestamp: "2026-07-28T11:01:00Z",
        type: WORK_ITEM_HISTORY_ACTION.MOVED,
        actorId: "member-1",
        userName: "Ada",
        descriptions: ["moved the work item"],
      },
      updatedEntry("two", "2026-07-28T11:02:00Z"),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["entry", "entry", "entry"]);
  });
});
