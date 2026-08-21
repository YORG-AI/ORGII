import { useCallback, useEffect, useReducer, useState } from "react";

import {
  type ReplaySpeed,
  createReplayControllerState,
  replayControllerReducer,
} from "./replayController";

const BASE_STEP_MS = 700;

function documentIsVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

export function useReplayController(eventCount: number) {
  const [state, dispatch] = useReducer(
    replayControllerReducer,
    eventCount,
    createReplayControllerState
  );
  const [documentVisible, setDocumentVisible] = useState(documentIsVisible);

  useEffect(() => {
    dispatch({ type: "sync", eventCount });
  }, [eventCount]);

  useEffect(() => {
    const handleVisibilityChange = () =>
      setDocumentVisible(documentIsVisible());
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (state.phase !== "playing" || !documentVisible) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "tick" }),
      BASE_STEP_MS / state.speed
    );
    return () => window.clearTimeout(timer);
  }, [documentVisible, state.index, state.phase, state.speed]);

  const seek = useCallback(
    (index: number) => dispatch({ type: "seek", index }),
    []
  );
  const play = useCallback(() => dispatch({ type: "play" }), []);
  const pause = useCallback(() => dispatch({ type: "pause" }), []);
  const browse = useCallback(() => dispatch({ type: "browse" }), []);
  const follow = useCallback(() => dispatch({ type: "follow" }), []);
  const setSpeed = useCallback(
    (speed: ReplaySpeed) => dispatch({ type: "set-speed", speed }),
    []
  );

  return { state, seek, play, pause, browse, follow, setSpeed };
}
