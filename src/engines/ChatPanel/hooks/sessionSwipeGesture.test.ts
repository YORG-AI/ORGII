import { describe, expect, it } from "vitest";

import {
  IDLE_SWIPE_STATE,
  SWIPE_IDLE_RESET_MS,
  SWIPE_START_DISTANCE,
  SWIPE_TRIGGER_DISTANCE,
  type SwipeGestureState,
  reduceSwipeWheel,
  resolveSwipeProgress,
} from "./sessionSwipeGesture";

const both = { canGoBack: true, canGoForward: true };

function run(
  deltas: Array<[number, number]>,
  availability = both,
  startAt = 1000,
  stepMs = 16
) {
  let state: SwipeGestureState = IDLE_SWIPE_STATE;
  const triggers: string[] = [];
  deltas.forEach(([deltaX, deltaY], index) => {
    const result = reduceSwipeWheel(
      state,
      { deltaX, deltaY, now: startAt + index * stepMs },
      availability
    );
    state = result.state;
    if (result.trigger) triggers.push(result.trigger);
  });
  return { state, triggers };
}

describe("reduceSwipeWheel", () => {
  it("accumulates leftward finger travel into a back gesture and fires once", () => {
    const step = -40;
    const count = Math.ceil(SWIPE_TRIGGER_DISTANCE / Math.abs(step)) + 3;
    const { state, triggers } = run(
      Array.from({ length: count }, () => [step, 0])
    );

    expect(triggers).toEqual(["back"]);
    expect(state.consumed).toBe(true);
    expect(state.distance).toBe(SWIPE_TRIGGER_DISTANCE);
  });

  it("maps positive deltaX to forward", () => {
    const { triggers } = run([
      [120, 0],
      [120, 0],
    ]);
    expect(triggers).toEqual(["forward"]);
  });

  it("ignores vertical scrolling and diagonal motion that is mostly vertical", () => {
    const { state, triggers } = run([
      [0, 80],
      [-10, 60],
      [-5, 40],
    ]);
    expect(triggers).toEqual([]);
    expect(state.direction).toBeNull();
    expect(state.distance).toBe(0);
  });

  it("does not build a gesture in a direction with no history", () => {
    const { state, triggers } = run(
      [
        [-120, 0],
        [-120, 0],
      ],
      { canGoBack: false, canGoForward: true }
    );
    expect(triggers).toEqual([]);
    expect(state.direction).toBeNull();
  });

  it("restarts the run when the direction flips", () => {
    const { state } = run([
      [-100, 0],
      [60, 0],
    ]);
    expect(state.direction).toBe("forward");
    expect(state.distance).toBe(60);
  });

  it("stays consumed through the inertial tail and resets after the idle gap", () => {
    const first = run([
      [-150, 0],
      [-150, 0],
      [-30, 0],
      [-30, 0],
    ]);
    expect(first.triggers).toEqual(["back"]);
    expect(first.state.consumed).toBe(true);

    const later = reduceSwipeWheel(
      first.state,
      {
        deltaX: -150,
        deltaY: 0,
        now: first.state.lastAt + SWIPE_IDLE_RESET_MS + 1,
      },
      both
    );
    expect(later.state.consumed).toBe(false);
    expect(later.state.direction).toBe("back");
    expect(later.state.distance).toBe(150);
  });

  it("reports progress only past the start threshold and caps at one", () => {
    expect(resolveSwipeProgress(0)).toBe(0);
    expect(resolveSwipeProgress(SWIPE_START_DISTANCE)).toBe(0);
    expect(resolveSwipeProgress(SWIPE_TRIGGER_DISTANCE)).toBe(1);
    expect(resolveSwipeProgress(SWIPE_TRIGGER_DISTANCE * 2)).toBe(1);
    const mid = resolveSwipeProgress(
      (SWIPE_START_DISTANCE + SWIPE_TRIGGER_DISTANCE) / 2
    );
    expect(mid).toBeCloseTo(0.5);
  });
});
