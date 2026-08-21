import {
  REPLAY_SPEED_OPTIONS,
  type ReplaySpeed,
} from "@src/config/workspace/replayConfig";

export const REPLAY_SPEEDS = REPLAY_SPEED_OPTIONS;
export type { ReplaySpeed };
export type ReplayPhase = "follow" | "paused" | "playing" | "ended";

export interface ReplayControllerState {
  phase: ReplayPhase;
  eventCount: number;
  index: number;
  speed: ReplaySpeed;
}

export type ReplayControllerAction =
  | { type: "sync"; eventCount: number }
  | { type: "seek"; index: number }
  | { type: "play" }
  | { type: "pause" }
  | { type: "browse" }
  | { type: "tick" }
  | { type: "follow" }
  | { type: "set-speed"; speed: ReplaySpeed };

function lastIndex(eventCount: number): number {
  return Math.max(-1, eventCount - 1);
}

function clampIndex(index: number, eventCount: number): number {
  return Math.min(
    Math.max(index, eventCount > 0 ? 0 : -1),
    lastIndex(eventCount)
  );
}

export function createReplayControllerState(
  eventCount: number
): ReplayControllerState {
  return {
    phase: "follow",
    eventCount,
    index: lastIndex(eventCount),
    speed: 1,
  };
}

export function replayControllerReducer(
  state: ReplayControllerState,
  action: ReplayControllerAction
): ReplayControllerState {
  switch (action.type) {
    case "sync": {
      const eventCount = Math.max(0, action.eventCount);
      if (state.phase === "follow") {
        return { ...state, eventCount, index: lastIndex(eventCount) };
      }
      const index = clampIndex(state.index, eventCount);
      return {
        ...state,
        eventCount,
        index,
        phase:
          state.phase === "playing" && index >= lastIndex(eventCount)
            ? "ended"
            : state.phase,
      };
    }
    case "seek": {
      const index = clampIndex(action.index, state.eventCount);
      return {
        ...state,
        index,
        phase: index === lastIndex(state.eventCount) ? "follow" : "paused",
      };
    }
    case "play": {
      if (state.eventCount === 0) return state;
      const atEnd = state.index >= lastIndex(state.eventCount);
      return {
        ...state,
        index: atEnd ? 0 : Math.max(0, state.index),
        phase: state.eventCount === 1 ? "ended" : "playing",
      };
    }
    case "pause":
      return state.phase === "playing" ? { ...state, phase: "paused" } : state;
    case "browse":
      return state.eventCount === 0
        ? state
        : {
            ...state,
            phase: "paused",
            index: clampIndex(state.index, state.eventCount),
          };
    case "tick": {
      if (state.phase !== "playing") return state;
      const nextIndex = state.index + 1;
      if (nextIndex >= lastIndex(state.eventCount)) {
        return {
          ...state,
          index: lastIndex(state.eventCount),
          phase: "ended",
        };
      }
      return { ...state, index: nextIndex };
    }
    case "follow":
      return {
        ...state,
        phase: "follow",
        index: lastIndex(state.eventCount),
      };
    case "set-speed":
      return { ...state, speed: action.speed };
  }
}
