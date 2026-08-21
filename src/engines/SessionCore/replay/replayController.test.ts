import { describe, expect, it } from "vitest";

import {
  createReplayControllerState,
  replayControllerReducer,
} from "./replayController";

describe("replayControllerReducer", () => {
  it("follows newly appended events while live", () => {
    const state = createReplayControllerState(2);
    expect(
      replayControllerReducer(state, { type: "sync", eventCount: 4 })
    ).toMatchObject({
      phase: "follow",
      index: 3,
      eventCount: 4,
    });
  });

  it("preserves a paused replay cursor when events append", () => {
    const paused = replayControllerReducer(createReplayControllerState(4), {
      type: "seek",
      index: 1,
    });
    expect(
      replayControllerReducer(paused, { type: "sync", eventCount: 6 })
    ).toMatchObject({ phase: "paused", index: 1, eventCount: 6 });
  });

  it("enters free browsing at the latest event without moving the cursor", () => {
    const state = replayControllerReducer(createReplayControllerState(4), {
      type: "browse",
    });

    expect(state).toMatchObject({ phase: "paused", index: 3, eventCount: 4 });
  });

  it("restarts from the first event and ends monotonically", () => {
    let state = replayControllerReducer(createReplayControllerState(3), {
      type: "play",
    });
    expect(state).toMatchObject({ phase: "playing", index: 0 });
    state = replayControllerReducer(state, { type: "tick" });
    expect(state).toMatchObject({ phase: "playing", index: 1 });
    state = replayControllerReducer(state, { type: "tick" });
    expect(state).toMatchObject({ phase: "ended", index: 2 });
    expect(replayControllerReducer(state, { type: "tick" })).toEqual(state);
  });
});
