import { describe, expect, it } from "vitest";

import { ratchetSeenCounts, unreadDiscussionCount } from "./discussionSeenAtom";

describe("ratchetSeenCounts", () => {
  it("raises watermarks and keeps identity when nothing grows", () => {
    const previous = { "org-1:sess-a": 3 };
    const raised = ratchetSeenCounts(previous, { "org-1:sess-a": 5 });
    expect(raised["org-1:sess-a"]).toBe(5);
    expect(ratchetSeenCounts(raised, { "org-1:sess-a": 4 })).toBe(raised);
    expect(ratchetSeenCounts(raised, {})).toBe(raised);
  });

  it("adds new keys without touching existing ones", () => {
    const next = ratchetSeenCounts(
      { "org-1:sess-a": 2 },
      { "org-1:sess-b": 1 }
    );
    expect(next).toEqual({ "org-1:sess-a": 2, "org-1:sess-b": 1 });
  });
});

describe("unreadDiscussionCount", () => {
  it("counts messages past the watermark and floors at zero", () => {
    expect(unreadDiscussionCount(5, 3)).toBe(2);
    expect(unreadDiscussionCount(3, 5)).toBe(0);
    expect(unreadDiscussionCount(undefined, 2)).toBe(0);
    expect(unreadDiscussionCount(4, undefined)).toBe(4);
  });
});
