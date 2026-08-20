/**
 * SimulatorStatusBar Component
 *
 * Status bar showing current mode and time information:
 * - Follow mode: "Following session time count [Replay]"
 * - Free browsing mode: "Free browsing (time stamp) [Follow]"
 *
 * Similar to Zoom's status bar at the bottom of meetings
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";

import { REPLAY_CONFIG } from "@src/config/workspace/replayConfig";
import {
  currentEventIdAtom,
  effectiveSimulatorEventIdsAtom,
  navigateNextSimulatorEventAtom,
  navigatePrevSimulatorEventAtom,
  replayBarValueAtom,
  replayModeAtom,
  simulatorEventCountAtom,
} from "@src/engines/SessionCore";
import {
  simulatorFollowAppLockAtom,
  simulatorSelectedAppAtom,
} from "@src/store/ui/simulatorAtom";

import { EventFilterDropdown } from "./EventFilterDropdown";
import { FollowModeDropdown } from "./FollowModeDropdown";
import { SimulatorStatusBarView } from "./SimulatorStatusBarView";

export { SimulatorStatusBarView } from "./SimulatorStatusBarView";
export type { SimulatorStatusBarViewProps } from "./SimulatorStatusBarView";

export interface SimulatorStatusBarProps {
  /** Callback when toggling between follow/free browsing */
  onToggleMode?: () => void;
  /** Whether auto-play is active */
  isReplaying?: boolean;
  /** Toggle play/pause */
  onPlayPause?: () => void;
  /** Playback speed multiplier (free browse); right of next-event control */
  playbackSpeed?: number;
  onPlaybackSpeedChange?: (speed: number) => void;
}

export const SimulatorStatusBar: React.FC<SimulatorStatusBarProps> = memo(
  ({
    onToggleMode,
    isReplaying = false,
    onPlayPause,
    playbackSpeed,
    onPlaybackSpeedChange,
  }) => {
    const [replayMode, setReplayMode] = useAtom(replayModeAtom);
    const effectiveSimulatorEventIds = useAtomValue(
      effectiveSimulatorEventIdsAtom
    );
    const eventCount = useAtomValue(simulatorEventCountAtom);
    const setCurrentEventId = useSetAtom(currentEventIdAtom);
    const setReplayBarValue = useSetAtom(replayBarValueAtom);
    const navigatePrev = useSetAtom(navigatePrevSimulatorEventAtom);
    const navigateNext = useSetAtom(navigateNextSimulatorEventAtom);
    const setSelectedApp = useSetAtom(simulatorSelectedAppAtom);
    const setFollowAppLock = useSetAtom(simulatorFollowAppLockAtom);

    const handleToggleToReplay = useCallback(() => {
      setReplayMode("replay");
      onToggleMode?.();
    }, [setReplayMode, onToggleMode]);

    const handleToggleToFollow = useCallback(() => {
      setReplayMode("follow");
      // Both `selectedApp` and `followAppLock` are free-browse-only
      // concepts ("I picked this app from the dock" / "while scrubbing
      // show only this app's events"). Entering follow means "agent
      // decides what to show", so any leftover from the previous replay
      // session would silently restrict the view while the pill claims
      // "Following Agent". Clear them on the way in.
      setSelectedApp(null);
      setFollowAppLock(null);

      const lastEventId = effectiveSimulatorEventIds.at(-1);
      if (lastEventId) {
        setCurrentEventId(lastEventId);
        setReplayBarValue(REPLAY_CONFIG.MAX_VALUE);
      }

      onToggleMode?.();
    }, [
      setReplayMode,
      setSelectedApp,
      setFollowAppLock,
      effectiveSimulatorEventIds,
      setCurrentEventId,
      setReplayBarValue,
      onToggleMode,
    ]);

    return (
      <SimulatorStatusBarView
        replayMode={replayMode}
        eventCount={eventCount}
        isReplaying={isReplaying}
        playbackSpeed={playbackSpeed}
        onPrevious={() => navigatePrev()}
        onPlayPause={() => onPlayPause?.()}
        onNext={() => navigateNext()}
        onPlaybackSpeedChange={onPlaybackSpeedChange}
        onEnterReplay={handleToggleToReplay}
        onFollow={handleToggleToFollow}
        followOptions={<EventFilterDropdown variant="primary" iconOnly />}
        replayOptions={
          <>
            <EventFilterDropdown iconOnly />
            <FollowModeDropdown />
          </>
        }
        showTimestamp
      />
    );
  }
);

SimulatorStatusBar.displayName = "SimulatorStatusBar";

export default SimulatorStatusBar;
