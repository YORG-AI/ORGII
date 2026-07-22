import { describe, expect, it } from "vitest";

import { formatTaskCardLastUpdated } from "./taskCardTime";

const NOW = Date.parse("2026-07-22T12:00:00.000Z");

describe("formatTaskCardLastUpdated", () => {
  it("shows Now for updates less than five minutes old", () => {
    expect(formatTaskCardLastUpdated("2026-07-22T11:55:01.000Z", NOW)).toBe(
      "Now"
    );
  });

  it("switches to a compact elapsed time at five minutes", () => {
    expect(formatTaskCardLastUpdated("2026-07-22T11:55:00.000Z", NOW)).toBe(
      "5m"
    );
    expect(formatTaskCardLastUpdated("2026-07-22T10:00:00.000Z", NOW)).toBe(
      "2h"
    );
  });

  it("returns an empty label for missing or invalid timestamps", () => {
    expect(formatTaskCardLastUpdated(undefined, NOW)).toBe("");
    expect(formatTaskCardLastUpdated("invalid", NOW)).toBe("");
  });
});
