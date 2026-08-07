import { describe, expect, it } from "vitest";

import {
  getSessionDateBucket,
  getSessionDateBucketRanges,
} from "./sessionDateBuckets";

function sessionAt(date: Date) {
  return {
    session_id: date.toISOString(),
    status: "completed",
    created_at: date.toISOString(),
    updated_at: date.toISOString(),
  };
}

describe("session date buckets", () => {
  const now = new Date(2026, 6, 12, 20, 0, 0);

  it("uses non-overlapping local-calendar boundaries", () => {
    const ranges = getSessionDateBucketRanges(now);

    expect(ranges.map((range) => range.bucket)).toEqual([
      "today",
      "yesterday",
      "thisWeek",
      "older",
    ]);
    expect(ranges[0].startMs).toBe(new Date(2026, 6, 12).getTime());
    expect(ranges[1]).toEqual({
      bucket: "yesterday",
      startMs: new Date(2026, 6, 11).getTime(),
      endMs: new Date(2026, 6, 12).getTime(),
    });
    expect(ranges[2].endMs).toBe(ranges[1].startMs);
    expect(ranges[3].endMs).toBe(ranges[2].startMs);
  });

  it("classifies rows with the same boundaries sent to SQLite", () => {
    expect(getSessionDateBucket(sessionAt(new Date(2026, 6, 12, 1)), now)).toBe(
      "today"
    );
    expect(
      getSessionDateBucket(sessionAt(new Date(2026, 6, 11, 23)), now)
    ).toBe("yesterday");
    expect(getSessionDateBucket(sessionAt(new Date(2026, 6, 8, 12)), now)).toBe(
      "thisWeek"
    );
    expect(getSessionDateBucket(sessionAt(new Date(2026, 6, 4, 23)), now)).toBe(
      "older"
    );
  });
});
