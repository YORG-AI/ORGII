/**
 * useGlobalReplay Hook
 *
 * Manages global play/pause/reset state for synchronized
 * multi-task playback across all grid cells.
 */
import { useSetAtom } from "jotai";
import { useCallback, useState } from "react";

import { DEFAULT_REPLAY_SPEED } from "@src/config/workspace/replayConfig";
import { globalReplayStateAtom } from "@src/store/ui/simulatorAtom";

export function useGlobalReplay() {
  const setGlobalReplayState = useSetAtom(globalReplayStateAtom);
  const [isGlobalPlaying, setIsGlobalPlaying] = useState(false);

  const handleGlobalPlay = useCallback(() => {
    setIsGlobalPlaying(true);
    setGlobalReplayState({
      isPlaying: true,
      triggerTime: Date.now(),
      speed: DEFAULT_REPLAY_SPEED,
    });
  }, [setGlobalReplayState]);

  const handleGlobalPause = useCallback(() => {
    setIsGlobalPlaying(false);
    setGlobalReplayState({
      isPlaying: false,
      triggerTime: Date.now(),
      speed: DEFAULT_REPLAY_SPEED,
    });
  }, [setGlobalReplayState]);

  const handleGlobalReset = useCallback(() => {
    setIsGlobalPlaying(false);
    // Emit a single reset trigger with isPlaying=false. Each cell's effect
    // detects the new triggerTime and resets currentIndex to 0 without
    // starting its local timer. The previous double-write pattern (play then
    // pause after 50ms) could race: if the first write landed between two
    // renders it would start timers that the second write had to cancel.
    setGlobalReplayState({
      isPlaying: false,
      triggerTime: Date.now(),
      speed: DEFAULT_REPLAY_SPEED,
    });
  }, [setGlobalReplayState]);

  return {
    isGlobalPlaying,
    handleGlobalPlay,
    handleGlobalPause,
    handleGlobalReset,
  };
}
