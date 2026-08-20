import React, { useCallback } from "react";

import type {
  ReplayControllerState,
  ReplaySpeed,
} from "@src/engines/SessionCore/replay/replayController";
import { REPLAY_SPEEDS } from "@src/engines/SessionCore/replay/replayController";

import { MusicPlayerReplayBarView } from "./MusicPlayerReplayBar";
import { SimulatorStatusBarView } from "./SimulatorStatusBar";

export interface RemoteSessionReplayControlsProps {
  state: ReplayControllerState;
  onSeek: (index: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onBrowse: () => void;
  onFollow: () => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
}

/**
 * Web-only state adapter around the desktop replay UI. This component owns no
 * replay styling or transport primitives: those stay in the Simulator's
 * shared MusicPlayerReplayBarView and SimulatorStatusBarView.
 */
export function RemoteSessionReplayControls({
  state,
  onSeek,
  onPlay,
  onPause,
  onBrowse,
  onFollow,
  onSpeedChange,
}: RemoteSessionReplayControlsProps) {
  const handleSpeedChange = useCallback(
    (speed: number) => {
      if (REPLAY_SPEEDS.includes(speed as ReplaySpeed)) {
        onSpeedChange(speed as ReplaySpeed);
      }
    },
    [onSpeedChange]
  );

  return (
    <div
      className="pointer-events-none absolute inset-0 z-30"
      data-session-replay-controls
    >
      {state.phase !== "follow" ? (
        <div className="pointer-events-auto absolute inset-x-0 bottom-12 border-t border-border-2">
          <MusicPlayerReplayBarView
            eventCount={state.eventCount}
            currentIndex={state.index}
            isFollowMode={false}
            onNavigateToIndex={onSeek}
            onFollowLatest={onFollow}
            ariaLabel="Session replay position"
          />
        </div>
      ) : null}
      <div className="pointer-events-auto absolute inset-x-0 bottom-14 flex items-center justify-center px-2">
        <SimulatorStatusBarView
          replayMode={state.phase === "follow" ? "follow" : "replay"}
          eventCount={state.eventCount}
          isReplaying={state.phase === "playing"}
          playbackSpeed={state.speed}
          onPrevious={() => onSeek(state.index - 1)}
          onPlayPause={state.phase === "playing" ? onPause : onPlay}
          onNext={() => onSeek(state.index + 1)}
          onPlaybackSpeedChange={handleSpeedChange}
          onEnterReplay={onBrowse}
          onFollow={onFollow}
        />
      </div>
    </div>
  );
}
