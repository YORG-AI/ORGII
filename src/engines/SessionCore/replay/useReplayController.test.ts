/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { useReplayController } from "./useReplayController";

function ReplayProbe() {
  const replay = useReplayController(3);
  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      { type: "button", "data-play": true, onClick: replay.play },
      "Play"
    ),
    React.createElement("output", {
      "data-phase": replay.state.phase,
      "data-index": replay.state.index,
    })
  );
}

describe("useReplayController", () => {
  let visibilityState: DocumentVisibilityState;

  beforeEach(() => {
    vi.useFakeTimers();
    visibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibilityState
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pauses playback timers while hidden and disposes them on unmount", async () => {
    const root = createSmokeRoot();
    await root.render(React.createElement(ReplayProbe));

    await dispatch(() =>
      root.container.querySelector<HTMLButtonElement>("[data-play]")?.click()
    );
    expect(root.container.querySelector("output")?.dataset).toMatchObject({
      phase: "playing",
      index: "0",
    });

    visibilityState = "hidden";
    await dispatch(() => document.dispatchEvent(new Event("visibilitychange")));
    await dispatch(() => vi.advanceTimersByTime(5_000));
    expect(root.container.querySelector("output")?.dataset.index).toBe("0");

    visibilityState = "visible";
    await dispatch(() => document.dispatchEvent(new Event("visibilitychange")));
    await dispatch(() => vi.advanceTimersByTime(700));
    expect(root.container.querySelector("output")?.dataset.index).toBe("1");

    await root.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
