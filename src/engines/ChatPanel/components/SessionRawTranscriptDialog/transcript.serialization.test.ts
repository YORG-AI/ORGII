import { describe, expect, it } from "vitest";

import { canCopyRawTranscript, stringifyJsonArrayBounded } from "./transcript";

describe("bounded raw transcript serialization", () => {
  it("never labels a released external window as Copy All complete", () => {
    const base = {
      sessionId: "codexapp-session-1",
      source: {
        kind: "external-history" as const,
        sourceId: "codex_app",
        displayName: "Codex App",
        target: {
          sourceId: "codex_app" as const,
          sessionId: "codexapp-session-1",
        },
      },
      loadedAt: "2026-07-18T00:00:03.000Z",
      entries: [],
      replay: {
        cursor: {
          sourceId: "codex_app" as const,
          sessionId: "codexapp-session-1",
          generation: "g1",
          revision: 1,
          throughSequence: 2,
        },
        windowStartSequence: 2,
        turnHeaders: [],
        totalTurnCount: 2,
        hasOlder: false,
        ipcBytes: 100,
      },
    };

    expect(canCopyRawTranscript(base, 1_024)).toBe(true);
    expect(
      canCopyRawTranscript(
        {
          ...base,
          replay: { ...base.replay, newerContentReleased: true },
        },
        1_024
      )
    ).toBe(false);
    expect(
      canCopyRawTranscript(
        { ...base, replay: { ...base.replay, hasOlder: true } },
        1_024
      )
    ).toBe(false);
  });

  it("pretty-prints a small array within the requested byte budget", () => {
    const serialized = stringifyJsonArrayBounded(
      [{ id: "one", text: "hello" }],
      1_024
    );

    expect(serialized).not.toBeNull();
    expect(JSON.parse(serialized!)).toEqual([{ id: "one", text: "hello" }]);
    expect(
      new TextEncoder().encode(serialized!).byteLength
    ).toBeLessThanOrEqual(1_024);
  });

  it("fails before joining a Copy All value beyond the hard budget", () => {
    expect(
      stringifyJsonArrayBounded([{ text: "x".repeat(4_096) }], 1_024)
    ).toBeNull();
  });
});
