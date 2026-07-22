import { describe, expect, it } from "vitest";

import {
  RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX,
  type ReplayVirtualAnchorInput,
  reconcileReplayVirtualAnchor,
} from "./replayVirtualAnchor";

function input(
  ids: string[],
  overrides: Partial<ReplayVirtualAnchorInput> = {}
): ReplayVirtualAnchorInput {
  return {
    sessionId: "codexapp-session-1",
    generation: "g1",
    revision: 1,
    throughSequence: 2_000,
    newerContentReleased: false,
    entries: ids.map((id) => ({ id })),
    ...overrides,
  };
}

describe("Raw Transcript replay virtual anchor", () => {
  it("decreases by the rows actually prepended", () => {
    const current = reconcileReplayVirtualAnchor(
      null,
      input(["event-10", "event-11"])
    );
    const next = reconcileReplayVirtualAnchor(
      current,
      input(["event-8", "event-9", "event-10", "event-11"], {
        throughSequence: 9,
      })
    );

    expect(next.firstItemIndex).toBe(current.firstItemIndex - 2);
  });

  it("keeps decreasing when the bounded window length stays constant", () => {
    const latestIds = Array.from(
      { length: 1_000 },
      (_, index) => `event-${1_000 + index}`
    );
    const current = reconcileReplayVirtualAnchor(null, input(latestIds));
    const boundedOlderIds = Array.from(
      { length: 1_000 },
      (_, index) => `event-${800 + index}`
    );
    const next = reconcileReplayVirtualAnchor(
      current,
      input(boundedOlderIds, {
        revision: 2,
        throughSequence: 999,
        newerContentReleased: true,
      })
    );

    expect(next.entries).toHaveLength(current.entries.length);
    expect(next.firstItemIndex).toBe(current.firstItemIndex - 200);
  });

  it("resets when the source returns to a newer or replacement window", () => {
    const current = reconcileReplayVirtualAnchor(
      null,
      input(["old-1", "latest-1"], {
        throughSequence: 10,
        newerContentReleased: true,
      })
    );
    const latest = input(["latest-1", "latest-2"], {
      throughSequence: 20,
      newerContentReleased: false,
    });
    const reset = reconcileReplayVirtualAnchor(current, latest);

    expect(reset.firstItemIndex).toBe(
      RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX - latest.entries.length
    );

    const replacement = input(["replacement"], {
      generation: "g2",
      revision: 1,
      throughSequence: 0,
    });
    expect(
      reconcileReplayVirtualAnchor(reset, replacement).firstItemIndex
    ).toBe(RAW_TRANSCRIPT_VIRTUAL_BASE_INDEX - 1);
  });
});
