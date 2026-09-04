import { describe, expect, it } from "vitest";

import {
  projectReplayVisibleEvents,
  resolveReplayEventWindow,
} from "../projectReplayEventWindow";

describe("resolveReplayEventWindow", () => {
  it("returns the full window in follow mode", () => {
    expect(resolveReplayEventWindow(5, "follow", 2)).toEqual({
      endIndex: 4,
      isFullWindow: true,
    });
  });

  it("clamps scrub indices to the event range", () => {
    expect(resolveReplayEventWindow(5, "paused", 99)).toEqual({
      endIndex: 4,
      isFullWindow: false,
    });
    expect(resolveReplayEventWindow(5, "playing", -3)).toEqual({
      endIndex: 0,
      isFullWindow: false,
    });
  });
});

describe("projectReplayVisibleEvents", () => {
  const events = ["a", "b", "c", "d"];

  it("reuses the source array in follow mode", () => {
    const window = resolveReplayEventWindow(events.length, "follow", 1);
    expect(projectReplayVisibleEvents(events, window)).toBe(events);
  });

  it("projects a prefix during replay scrub", () => {
    const window = resolveReplayEventWindow(events.length, "paused", 1);
    expect(projectReplayVisibleEvents(events, window)).toEqual(["a", "b"]);
  });
});
