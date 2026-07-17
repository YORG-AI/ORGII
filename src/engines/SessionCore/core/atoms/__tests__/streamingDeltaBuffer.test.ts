import type { SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamingDeltaContent } from "../events";
import {
  bufferStreamingDelta,
  clearStreamingDelta,
  discardStreamingDeltaBuffer,
  flushStreamingDeltas,
} from "../streamingDeltaBuffer";

type DeltaMap = Map<string, StreamingDeltaContent>;

/** Applies setter updates to a live map and records every resulting state. */
function createAtomHarness() {
  const harness = {
    map: new Map() as DeltaMap,
    history: [] as DeltaMap[],
    set: (update: SetStateAction<DeltaMap>) => {
      harness.map = typeof update === "function" ? update(harness.map) : update;
      harness.history.push(harness.map);
    },
  };
  return harness;
}

describe("streamingDeltaBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    discardStreamingDeltaBuffer();
  });

  afterEach(() => {
    discardStreamingDeltaBuffer();
    vi.useRealTimers();
  });

  it("flushes the first chunk of an idle session immediately (leading edge)", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta("s1", { kind: "message", content: "a" }, harness.set);
    expect(harness.map.get("s1")).toEqual({ kind: "message", content: "a" });
  });

  it("buffers subsequent chunks and trail-flushes at ~50ms with the newest content", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta("s1", { kind: "message", content: "a" }, harness.set);
    bufferStreamingDelta("s1", { kind: "message", content: "ab" }, harness.set);
    bufferStreamingDelta(
      "s1",
      { kind: "message", content: "abc" },
      harness.set
    );
    // Still showing the leading-edge flush — no per-chunk atom writes.
    expect(harness.map.get("s1")).toEqual({ kind: "message", content: "a" });

    vi.advanceTimersByTime(49);
    expect(harness.map.get("s1")).toEqual({ kind: "message", content: "a" });

    vi.advanceTimersByTime(1);
    expect(harness.map.get("s1")).toEqual({ kind: "message", content: "abc" });
  });

  it("flushes the complete accumulated content on completion, then clears", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta("s1", { kind: "message", content: "a" }, harness.set);
    bufferStreamingDelta("s1", { kind: "message", content: "ab" }, harness.set);
    bufferStreamingDelta(
      "s1",
      { kind: "message", content: "abc" },
      harness.set
    );

    clearStreamingDelta("s1", harness.set);

    // The full accumulated content was written before the removal.
    const contents = harness.history.map((state) => state.get("s1")?.content);
    expect(contents).toContain("abc");
    expect(harness.map.has("s1")).toBe(false);
  });

  it("never resurrects a cleared session from a stale trailing flush", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta("s1", { kind: "message", content: "a" }, harness.set);
    bufferStreamingDelta("s1", { kind: "message", content: "ab" }, harness.set);

    // Direct clear path (session switch / timeline boundary): discard the
    // buffer, then clear the atom without going through clearStreamingDelta.
    discardStreamingDeltaBuffer("s1");
    harness.set(new Map());
    const writesAfterClear = harness.history.length;

    vi.advanceTimersByTime(200);
    flushStreamingDeltas();
    expect(harness.map.has("s1")).toBe(false);
    expect(harness.history.length).toBe(writesAfterClear);
  });

  it("flushes immediately on a kind change so transitions render without lag", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta(
      "s1",
      { kind: "thinking", content: "reasoning" },
      harness.set
    );
    bufferStreamingDelta(
      "s1",
      { kind: "thinking", content: "reasoning more" },
      harness.set
    );
    // Pending thinking chunk is un-flushed; a kind change flushes now.
    bufferStreamingDelta(
      "s1",
      { kind: "message", content: "answer" },
      harness.set
    );
    expect(harness.map.get("s1")).toEqual({
      kind: "message",
      content: "answer",
    });
  });

  it("keeps concurrent sessions independent within one flush", () => {
    const harness = createAtomHarness();
    bufferStreamingDelta("s1", { kind: "message", content: "a" }, harness.set);
    bufferStreamingDelta("s2", { kind: "thinking", content: "t" }, harness.set);
    bufferStreamingDelta("s1", { kind: "message", content: "ab" }, harness.set);
    bufferStreamingDelta(
      "s2",
      { kind: "thinking", content: "tt" },
      harness.set
    );

    vi.advanceTimersByTime(50);
    expect(harness.map.get("s1")).toEqual({ kind: "message", content: "ab" });
    expect(harness.map.get("s2")).toEqual({ kind: "thinking", content: "tt" });
  });
});
