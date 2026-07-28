import { describe, expect, it } from "vitest";

import type { ActivityChunk } from "@src/types/session/session";

import { selectExternalHistoryInitialWindow } from "../externalHistoryAdapter";

function chunk(index: number, actionType = "tool_call", fn = "run_shell") {
  return {
    chunk_id: `chunk-${index}`,
    action_type: actionType,
    function: fn,
    args: {},
    result: {},
    created_at: `2026-02-11T06:${String(index % 60).padStart(2, "0")}:00.000Z`,
  } satisfies ActivityChunk;
}

describe("external history initial window", () => {
  it("returns short histories unchanged", () => {
    const chunks = [chunk(0, "raw", "user_message"), chunk(1)];

    expect(selectExternalHistoryInitialWindow(chunks)).toBe(chunks);
  });

  it("bounds legacy non-windowed sources at a user-turn boundary", () => {
    const chunks = Array.from({ length: 250 }, (_, index) => {
      const isUser = index === 40 || index === 100 || index === 200;
      return chunk(
        index,
        isUser ? "raw" : "tool_call",
        isUser ? "user_message" : "run_shell"
      );
    });

    const window = selectExternalHistoryInitialWindow(chunks, {
      supportsWindowedReplay: false,
    });

    expect(window[0].chunk_id).toBe("chunk-40");
    expect(window).toHaveLength(210);
  });

  it("preserves source-level placeholders for windowed sources", () => {
    const chunks = Array.from({ length: 250 }, (_, index) =>
      chunk(index, index % 2 === 0 ? "raw" : "tool_call", "user_message")
    );

    expect(
      selectExternalHistoryInitialWindow(chunks, {
        supportsWindowedReplay: true,
      })
    ).toBe(chunks);
  });

  it("expands the tail window back to the current user round", () => {
    const chunks = [
      chunk(0, "raw", "user_message"),
      chunk(1),
      chunk(2, "raw", "user_message"),
      ...Array.from({ length: 200 }, (_, index) => chunk(index + 3)),
    ];

    const window = selectExternalHistoryInitialWindow(chunks);

    expect(window[0].chunk_id).toBe("chunk-2");
    expect(window).toHaveLength(201);
  });

  it("falls back to the fixed tail when no user boundary is available", () => {
    const chunks = Array.from({ length: 205 }, (_, index) => chunk(index));

    const window = selectExternalHistoryInitialWindow(chunks);

    expect(window[0].chunk_id).toBe("chunk-5");
    expect(window).toHaveLength(200);
  });
});
