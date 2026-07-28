import { describe, expect, it } from "vitest";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";
import type { Person } from "@src/types/core/shared";

import {
  isCurrentTimelineActor,
  resolveTimelineActorVisual,
} from "../timelineActorVisual";
import type { TimelineEntry } from "../types";

const currentUser: Person = {
  id: "member-1",
  name: "Hanafish",
  avatar: "https://example.com/current.png",
  color: "#52c41a",
};

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: "comment-1",
    timestamp: "2026-07-28T15:39:00.000Z",
    type: WORK_ITEM_HISTORY_ACTION.COMMENTED,
    actorId: "legacy-user-id",
    userName: " hanafish ",
    descriptions: ["可以的"],
    ...overrides,
  };
}

describe("timeline actor visual identity", () => {
  it("matches legacy actor names without case or surrounding-space drift", () => {
    expect(isCurrentTimelineActor(makeEntry(), currentUser)).toBe(true);
  });

  it("uses current member visuals instead of stale event fallbacks", () => {
    expect(
      resolveTimelineActorVisual(
        makeEntry({
          userAvatar: "https://example.com/stale.png",
          userColor: "var(--color-fill-3)",
        }),
        currentUser
      )
    ).toEqual({
      avatar: "https://example.com/current.png",
      color: "#52c41a",
    });
  });

  it("preserves another actor's persisted visual identity", () => {
    expect(
      resolveTimelineActorVisual(
        makeEntry({
          actorId: "member-2",
          userName: "Lin",
          userAvatar: "https://example.com/lin.png",
          userColor: "#1677ff",
        }),
        currentUser
      )
    ).toEqual({
      avatar: "https://example.com/lin.png",
      color: "#1677ff",
    });
  });
});
