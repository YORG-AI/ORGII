import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore";

import { mergeCloudSessionEventSnapshot } from "./cloudSessionSegments";

const event = (id: string): SessionEvent =>
  ({ id, sessionId: "session-1", createdAt: id }) as SessionEvent;

describe("mergeCloudSessionEventSnapshot", () => {
  it("replaces a rolled tail instead of duplicating it", () => {
    const initial = mergeCloudSessionEventSnapshot(
      null,
      {
        epoch: 1,
        frozenSeq: 1,
        tailHash: "tail-a",
        count: 2,
        segments: [
          {
            seq: 1,
            isTail: false,
            events: [event("a")],
            eventCount: 1,
            segmentHash: "a",
          },
          {
            seq: 0,
            isTail: true,
            events: [event("b")],
            eventCount: 1,
            segmentHash: "tail-a",
          },
        ],
      },
      true
    );
    const merged = mergeCloudSessionEventSnapshot(
      initial,
      {
        epoch: 1,
        frozenSeq: 2,
        tailHash: "tail-b",
        count: 3,
        segments: [
          {
            seq: 2,
            isTail: false,
            events: [event("b")],
            eventCount: 1,
            segmentHash: "b",
          },
          {
            seq: 0,
            isTail: true,
            events: [event("c")],
            eventCount: 1,
            segmentHash: "tail-b",
          },
        ],
      },
      false
    );
    expect(merged.events.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("preserves the previous snapshot object when an incremental poll is unchanged", () => {
    const initial = mergeCloudSessionEventSnapshot(
      null,
      {
        epoch: 1,
        frozenSeq: 1,
        tailHash: "tail-a",
        count: 2,
        segments: [
          {
            seq: 1,
            isTail: false,
            events: [event("a")],
            eventCount: 1,
            segmentHash: "a",
          },
          {
            seq: 0,
            isTail: true,
            events: [event("b")],
            eventCount: 1,
            segmentHash: "tail-a",
          },
        ],
      },
      true
    );
    const unchanged = mergeCloudSessionEventSnapshot(
      initial,
      {
        epoch: 1,
        frozenSeq: 1,
        tailHash: "tail-a",
        count: 2,
        segments: [
          {
            seq: 1,
            isTail: false,
            events: [event("a")],
            eventCount: 1,
            segmentHash: "a",
          },
          {
            seq: 0,
            isTail: true,
            events: [event("b")],
            eventCount: 1,
            segmentHash: "tail-a",
          },
        ],
      },
      false
    );
    expect(unchanged).toBe(initial);
    expect(unchanged.events).toBe(initial.events);
  });

  it("replaces the complete snapshot when the epoch changes", () => {
    const initial = mergeCloudSessionEventSnapshot(
      null,
      {
        epoch: 1,
        frozenSeq: 0,
        tailHash: "old",
        count: 1,
        segments: [
          {
            seq: 0,
            isTail: true,
            events: [event("old")],
            eventCount: 1,
            segmentHash: "old",
          },
        ],
      },
      true
    );
    const rewritten = mergeCloudSessionEventSnapshot(
      initial,
      {
        epoch: 2,
        frozenSeq: 0,
        tailHash: "new",
        count: 1,
        segments: [
          {
            seq: 0,
            isTail: true,
            events: [event("new")],
            eventCount: 1,
            segmentHash: "new",
          },
        ],
      },
      false
    );
    expect(rewritten.events.map((item) => item.id)).toEqual(["new"]);
  });
});
