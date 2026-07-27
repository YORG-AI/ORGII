import { describe, expect, it } from "vitest";

import { DEFAULT_REPLAY_SPEED, REPLAY_SPEED_OPTIONS } from "./replayConfig";

describe("replayConfig", () => {
  it("supports the workstation replay speeds", () => {
    expect(REPLAY_SPEED_OPTIONS).toEqual([0.25, 0.5, 1, 2, 4, 6]);
    expect(REPLAY_SPEED_OPTIONS).toContain(DEFAULT_REPLAY_SPEED);
  });
});
