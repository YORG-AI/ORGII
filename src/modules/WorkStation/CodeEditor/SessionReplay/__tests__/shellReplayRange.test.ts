import { describe, expect, it } from "vitest";

import {
  type ShellReplayFrame,
  ShellReplayRangeCache,
  buildShellReplayVisualRows,
  filterFramesToBookmark,
  mergeReplayFrameWindow,
  replayFramesMemoryBytes,
  replayWindowBounds,
  shellReplayRangeCacheKey,
} from "@src/engines/SessionCore/replay/shellReplayRange";

function frame(
  sequence: number,
  byteStart: number,
  text: string
): ShellReplayFrame {
  const byteLength = new TextEncoder().encode(text).length;
  return {
    sequence,
    stream: "stdout",
    byteStart,
    byteEnd: byteStart + byteLength,
    text,
  };
}

describe("shell replay watermark filtering", () => {
  it("drops future frames and trims a crossing UTF-8 frame safely", () => {
    const frames = [frame(1, 0, "abc"), frame(2, 3, "你x"), frame(3, 7, "z")];
    const result = filterFramesToBookmark(frames, {
      visibleThroughSequence: 2,
      visibleBytes: 6,
    });

    expect(result.map((item) => item.sequence)).toEqual([1, 2]);
    expect(result[1].text).toBe("你");
    expect(result[1].byteEnd).toBe(6);
  });

  it("does not render a partial UTF-8 codepoint at a byte watermark", () => {
    const result = filterFramesToBookmark([frame(1, 0, "你x")], {
      visibleThroughSequence: 1,
      visibleBytes: 2,
    });

    expect(result).toEqual([]);
  });

  it("keeps a bounded sliding frame window", () => {
    const frames = Array.from({ length: 20 }, (_, index) =>
      frame(index + 1, index * 100, "x".repeat(100))
    );
    const merged = mergeReplayFrameWindow(
      [],
      frames,
      { visibleThroughSequence: 20, visibleBytes: 2_000 },
      "initial",
      500
    );

    expect(replayFramesMemoryBytes(merged)).toBeLessThanOrEqual(500);
    expect(merged.at(-1)?.sequence).toBe(20);
    expect(merged[0].sequence).toBeGreaterThan(1);
  });

  it("deduplicates a backend frame repeated after range alignment", () => {
    const merged = mergeReplayFrameWindow(
      [frame(4, 0, "first")],
      [frame(4, 0, "replacement")],
      { visibleThroughSequence: 4, visibleBytes: 11 },
      "append"
    );

    expect(merged.map((item) => item.text)).toEqual(["replacement"]);
  });

  it("uses the backend continuation cursor after an aligned read", () => {
    const alignedFrame = frame(4, 64, "complete frame");
    const response = {
      frames: [alignedFrame],
      nextOffsetBytes: alignedFrame.byteEnd,
      eof: false,
    };

    expect(replayWindowBounds([alignedFrame], response, 70)).toEqual({
      earliest: 64,
      latest: alignedFrame.byteEnd,
    });
  });
});

describe("ShellReplayRangeCache", () => {
  it("uses one global budget across multiple component windows", () => {
    const cache = new ShellReplayRangeCache(450);
    const firstKey = cache.setWindow("component-one", {
      frames: [frame(1, 0, "a".repeat(100))],
      earliestOffset: 0,
      latestOffset: 100,
    });
    const secondKey = cache.setWindow("component-two", {
      frames: [frame(2, 100, "b".repeat(100))],
      earliestOffset: 100,
      latestOffset: 200,
    });
    const thirdKey = cache.setWindow("component-three", {
      frames: [frame(3, 200, "c".repeat(100))],
      earliestOffset: 200,
      latestOffset: 300,
    });

    expect(cache.currentSizeBytes).toBeLessThanOrEqual(450);
    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBeNull();
    expect(thirdKey).not.toBeNull();
    expect(cache.peekWindow(firstKey)).toBeUndefined();
    expect(cache.peekWindow(secondKey)?.frames[0].sequence).toBe(2);
    expect(cache.peekWindow(thirdKey)?.frames[0].sequence).toBe(3);
  });

  it("isolates cache entries by Snapshot watermark", () => {
    const early = shellReplayRangeCacheKey("s", "c", 0, 100, 2, 50);
    const late = shellReplayRangeCacheKey("s", "c", 0, 100, 8, 400);
    expect(early).not.toBe(late);
  });

  it("notifies mounted consumers when an LRU eviction invalidates a window key", () => {
    const cache = new ShellReplayRangeCache(250);
    let notifications = 0;
    const unsubscribe = cache.subscribe(() => {
      notifications += 1;
    });
    const evictedKey = cache.setWindow("first", {
      frames: [frame(1, 0, "a".repeat(100))],
      earliestOffset: 0,
      latestOffset: 100,
    });
    cache.setWindow("second", {
      frames: [frame(2, 100, "b".repeat(100))],
      earliestOffset: 100,
      latestOffset: 200,
    });

    expect(notifications).toBe(2);
    expect(cache.peekWindow(evictedKey)).toBeUndefined();
    unsubscribe();
  });
});

describe("shell replay logical row assembly", () => {
  function renderedText(rows: ReturnType<typeof buildShellReplayVisualRows>) {
    return rows
      .map((row) => row.spans.map((span) => span.text).join(""))
      .join("\n");
  }

  it.each([100, 1024])(
    "does not create visual newlines at %i-byte frame boundaries",
    (chunkBytes) => {
      const frames = Array.from({ length: 12 }, (_, index) =>
        frame(
          index + 1,
          index * chunkBytes,
          String(index % 10).repeat(chunkBytes)
        )
      );
      const rows = buildShellReplayVisualRows(frames);

      expect(rows).toHaveLength(1);
      expect(renderedText(rows)).toBe(frames.map((item) => item.text).join(""));
    }
  );

  it("carries ANSI parser state across storage frames", () => {
    const parts = ["before\u001b[3", "1mred\u001b]0;ti", "tle\u0007after"];
    let offset = 0;
    const frames = parts.map((text, index) => {
      const result = frame(index + 1, offset, text);
      offset = result.byteEnd;
      return result;
    });

    expect(renderedText(buildShellReplayVisualRows(frames))).toBe(
      "beforeredafter"
    );
  });

  it("slices an ultra-long logical line without inserting a newline", () => {
    const text = `start-${"你🙂x".repeat(8_000)}-end`;
    const rows = buildShellReplayVisualRows([frame(1, 0, text)]);

    expect(rows).toHaveLength(1);
    expect(rows[0].spans.length).toBeGreaterThan(1);
    expect(renderedText(rows)).toBe(text);
  });
});
