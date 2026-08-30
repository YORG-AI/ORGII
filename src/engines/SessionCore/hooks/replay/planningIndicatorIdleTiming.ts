import { useEffect, useReducer, useRef } from "react";

/** How long (ms) to wait without new events before showing the indicator */
export const PLANNING_IDLE_THRESHOLD_MS = 1000;

export interface PlanningIdleTimingState {
  activationVersion: number | null;
  idleAfterVersion: number | null;
}

type PlanningIdleTimingAction =
  | { type: "session_inactive" }
  | { type: "activate"; version: number }
  | { type: "arm_idle"; version: number };

const INITIAL_IDLE_TIMING: PlanningIdleTimingState = {
  activationVersion: null,
  idleAfterVersion: null,
};

export function planningIdleTimingReducer(
  state: PlanningIdleTimingState,
  action: PlanningIdleTimingAction
): PlanningIdleTimingState {
  switch (action.type) {
    case "session_inactive":
      return INITIAL_IDLE_TIMING;
    case "activate":
      return { ...state, activationVersion: action.version };
    case "arm_idle":
      return { ...state, idleAfterVersion: action.version };
    default:
      return state;
  }
}

/**
 * Tracks cold-start and post-mutation idle timing for the planning footer.
 * Uses a reducer for activation/idle version bookkeeping and a single effect
 * for the warm-path debounce timer.
 */
export function usePlanningIdleTiming(
  isSessionActive: boolean,
  version: number
): PlanningIdleTimingState {
  const [state, dispatch] = useReducer(
    planningIdleTimingReducer,
    INITIAL_IDLE_TIMING
  );
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (!isSessionActive) {
      dispatch({ type: "session_inactive" });
      return;
    }

    if (state.activationVersion === null) {
      dispatch({ type: "activate", version });
      return;
    }

    idleTimerRef.current = setTimeout(() => {
      dispatch({ type: "arm_idle", version });
    }, PLANNING_IDLE_THRESHOLD_MS);

    return () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isSessionActive, version, state.activationVersion]);

  return state;
}
