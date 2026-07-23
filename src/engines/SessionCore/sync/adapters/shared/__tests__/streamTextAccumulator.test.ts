import { describe, expect, it } from "vitest";

import {
  MAX_TOOL_CALL_DELTA_BUFFERS,
  MAX_TOOL_CALL_DELTA_CHARS,
  appendBoundedToolCallArgs,
  makeRoomForToolCallDelta,
  mergeStreamingText,
} from "../streamTextAccumulator";

describe("mergeStreamingText", () => {
  it("appends normal delta fragments", () => {
    expect(mergeStreamingText("Hello ", "world")).toBe("Hello world");
  });

  it("replaces with cumulative snapshots", () => {
    expect(mergeStreamingText("Hello", "Hello world")).toBe("Hello world");
  });

  it("replaces with cumulative snapshots after the current buffer was capped", () => {
    expect(
      mergeStreamingText(
        "Second sentence begins",
        "First sentence. Second sentence begins"
      )
    ).toBe("First sentence. Second sentence begins");
  });

  it("ignores meaningful exact replay frames", () => {
    expect(
      mergeStreamingText(
        "The assistant starts here",
        "The assistant starts here"
      )
    ).toBe("The assistant starts here");
  });

  it("ignores meaningful replayed tail frames", () => {
    expect(
      mergeStreamingText("The assistant starts here", "assistant starts here")
    ).toBe("The assistant starts here");
  });

  it("appends tiny repeated fragments because they may be intentional output", () => {
    expect(mergeStreamingText("ha", "ha")).toBe("haha");
  });

  it("preserves meaningful repeated prefixes", () => {
    expect(
      mergeStreamingText(
        "Important note: first point. ",
        "Important note: second point."
      )
    ).toBe("Important note: first point. Important note: second point.");
  });

  it("does not collapse short overlaps that may be intentional output", () => {
    expect(mergeStreamingText("abc", "cde")).toBe("abccde");
  });

  it("appends only the non-overlapping tail for meaningful replay overlap", () => {
    expect(
      mergeStreamingText(
        "First sentence. Second sentence begins",
        "sentence begins and continues"
      )
    ).toBe("First sentence. Second sentence begins and continues");
  });

  it("handles very large overlap checks without quadratic suffix scanning", () => {
    const current = `${"a".repeat(20_000)}meaningful overlap prefix`;
    const incoming = `meaningful overlap prefix${"b".repeat(20_000)}`;

    expect(mergeStreamingText(current, incoming)).toBe(
      `${current}${"b".repeat(20_000)}`
    );
  });
});

describe("tool-call delta bounds", () => {
  it("caps accumulated JSON arguments", () => {
    const current = "a".repeat(MAX_TOOL_CALL_DELTA_CHARS - 2);
    const result = appendBoundedToolCallArgs(current, "bcdef");

    expect(result).toHaveLength(MAX_TOOL_CALL_DELTA_CHARS);
    expect(result.endsWith("bc")).toBe(true);
  });

  it("evicts the oldest incomplete tool call at the map cap", () => {
    const buffers = new Map<number, string>();
    for (let index = 0; index < MAX_TOOL_CALL_DELTA_BUFFERS; index++) {
      buffers.set(index, String(index));
    }

    makeRoomForToolCallDelta(buffers, MAX_TOOL_CALL_DELTA_BUFFERS);

    expect(buffers.size).toBe(MAX_TOOL_CALL_DELTA_BUFFERS - 1);
    expect(buffers.has(0)).toBe(false);
  });
});
