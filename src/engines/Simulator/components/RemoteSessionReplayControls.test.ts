/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { RemoteSessionReplayControls } from "./RemoteSessionReplayControls";

vi.mock("./MusicPlayerReplayBar", () => ({
  MusicPlayerReplayBarView: ({
    onNavigateToIndex,
    onFollowLatest,
  }: {
    onNavigateToIndex: (index: number) => void;
    onFollowLatest: () => void;
  }) =>
    React.createElement(
      "div",
      { "data-desktop-replay-progress": true },
      React.createElement(
        "button",
        { onClick: () => onNavigateToIndex(2) },
        "scrub"
      ),
      React.createElement(
        "button",
        { onClick: onFollowLatest },
        "scrub-to-live"
      )
    ),
}));

vi.mock("./SimulatorStatusBar", () => ({
  SimulatorStatusBarView: ({
    replayMode,
    onPrevious,
    onPlayPause,
    onNext,
    onPlaybackSpeedChange,
    onEnterReplay,
    onFollow,
  }: {
    replayMode: string;
    onPrevious: () => void;
    onPlayPause: () => void;
    onNext: () => void;
    onPlaybackSpeedChange: (speed: number) => void;
    onEnterReplay: () => void;
    onFollow: () => void;
  }) =>
    React.createElement(
      "div",
      { "data-desktop-replay-status": replayMode },
      ...[
        ["previous", onPrevious],
        ["play-pause", onPlayPause],
        ["next", onNext],
        ["speed-6", () => onPlaybackSpeedChange(6)],
        ["speed-invalid", () => onPlaybackSpeedChange(3)],
        ["browse", onEnterReplay],
        ["follow", onFollow],
      ].map(([label, onClick]) =>
        React.createElement(
          "button",
          { key: label as string, onClick: onClick as () => void },
          label as string
        )
      )
    ),
}));

function button(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label
  );
}

describe("RemoteSessionReplayControls", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("uses the desktop status view in follow mode and enters browsing", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    const onBrowse = vi.fn();

    await root.render(
      React.createElement(RemoteSessionReplayControls, {
        state: { phase: "follow", eventCount: 4, index: 3, speed: 1 },
        onSeek: vi.fn(),
        onPlay: vi.fn(),
        onPause: vi.fn(),
        onBrowse,
        onFollow: vi.fn(),
        onSpeedChange: vi.fn(),
      })
    );

    expect(
      root.container.querySelector("[data-desktop-replay-progress]")
    ).toBeNull();
    expect(
      root.container
        .querySelector("[data-desktop-replay-status]")
        ?.getAttribute("data-desktop-replay-status")
    ).toBe("follow");

    await dispatch(() => button(root.container, "browse")?.click());
    expect(onBrowse).toHaveBeenCalledOnce();
  });

  it("maps desktop replay transport actions to the Web controller", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    const onSeek = vi.fn();
    const onPlay = vi.fn();
    const onFollow = vi.fn();
    const onSpeedChange = vi.fn();

    await root.render(
      React.createElement(RemoteSessionReplayControls, {
        state: { phase: "paused", eventCount: 4, index: 1, speed: 1 },
        onSeek,
        onPlay,
        onPause: vi.fn(),
        onBrowse: vi.fn(),
        onFollow,
        onSpeedChange,
      })
    );

    expect(
      root.container.querySelector("[data-desktop-replay-progress]")
    ).not.toBeNull();
    for (const label of [
      "previous",
      "play-pause",
      "next",
      "scrub",
      "speed-6",
      "speed-invalid",
      "follow",
    ]) {
      await dispatch(() => button(root.container, label)?.click());
    }

    expect(onSeek.mock.calls).toEqual([[0], [2], [2]]);
    expect(onPlay).toHaveBeenCalledOnce();
    expect(onSpeedChange).toHaveBeenCalledOnce();
    expect(onSpeedChange).toHaveBeenCalledWith(6);
    expect(onFollow).toHaveBeenCalledOnce();
  });
});
