import { describe, expect, it } from "vitest";

import { summarizeTrackedValue } from "../apiTrackerPayload";

describe("summarizeTrackedValue", () => {
  it("replaces large request bodies with bounded metadata", () => {
    const summary = summarizeTrackedValue("x".repeat(200_000));

    expect(summary).toMatchObject({
      __orgiiTrackerSummary: "string",
      length: 200_000,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(10_000);
  });

  it("does not retain a full event batch in API diagnostics", () => {
    const args = {
      sessionId: "imported-session",
      events: Array.from({ length: 500 }, (_unused, index) => ({
        id: `event-${index}`,
        content: "payload".repeat(2_000),
      })),
    };

    const summary = summarizeTrackedValue(args) as {
      events: {
        __orgiiTrackerSummary: string;
        length: number;
        sample: unknown[];
      };
    };

    expect(summary.events).toMatchObject({
      __orgiiTrackerSummary: "Array",
      length: 500,
    });
    expect(summary.events.sample).toHaveLength(2);
    expect(JSON.stringify(summary).length).toBeLessThan(40_000);
  });

  it("bounds cycles, depth, and binary payloads", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(summarizeTrackedValue(circular)).toEqual({
      self: { __orgiiTrackerSummary: "circular" },
    });
    expect(summarizeTrackedValue(new Uint8Array(1_024))).toEqual({
      __orgiiTrackerSummary: "Uint8Array",
      byteLength: 1_024,
    });
  });
});
