import { useCallback, useEffect, useReducer, useRef } from "react";

export type ScopedRequestResolution<T> =
  | { phase: "loading"; data: null; error: null }
  | { phase: "unsupported"; data: null; error: null }
  | { phase: "error"; data: null; error: string }
  | { phase: "ready"; data: T; error: string | null };

export interface ScopedRequestState<T> {
  scopeKey: string | null;
  resolution: ScopedRequestResolution<T>;
  refreshing: boolean;
}

type ScopedRequestAction<T> =
  | { type: "start"; scopeKey: string }
  | { type: "unsupported" }
  | { type: "success"; data: T }
  | { type: "failure"; error: string }
  | { type: "finish" };

const LOADING_RESOLUTION: ScopedRequestResolution<never> = {
  phase: "loading",
  data: null,
  error: null,
};

function initialState<T>(): ScopedRequestState<T> {
  return {
    scopeKey: null,
    resolution: LOADING_RESOLUTION,
    refreshing: false,
  };
}

export function scopedRequestReducer<T>(
  state: ScopedRequestState<T>,
  action: ScopedRequestAction<T>
): ScopedRequestState<T> {
  switch (action.type) {
    case "start": {
      if (
        state.scopeKey === action.scopeKey &&
        state.resolution.phase === "ready"
      ) {
        return {
          scopeKey: action.scopeKey,
          resolution: { ...state.resolution, error: null },
          refreshing: true,
        };
      }
      return {
        scopeKey: action.scopeKey,
        resolution: LOADING_RESOLUTION,
        refreshing: true,
      };
    }
    case "unsupported":
      return {
        ...state,
        resolution: { phase: "unsupported", data: null, error: null },
      };
    case "success":
      return {
        ...state,
        resolution: { phase: "ready", data: action.data, error: null },
      };
    case "failure":
      return {
        ...state,
        resolution:
          state.resolution.phase === "ready"
            ? { ...state.resolution, error: action.error }
            : { phase: "error", data: null, error: action.error },
      };
    case "finish":
      return state.refreshing ? { ...state, refreshing: false } : state;
  }
}

/**
 * Coordinates one identity/resource-scoped request stream. Every start gets a
 * generation; only the latest generation may commit. Starting the same scope
 * retains ready rows for background revalidation, while a scope switch starts
 * from an empty loading resolution so data cannot cross identity boundaries.
 */
export function useScopedRequestMachine<T>() {
  const [state, dispatch] = useReducer(scopedRequestReducer<T>, undefined, () =>
    initialState<T>()
  );
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    []
  );

  const begin = useCallback((scopeKey: string): number => {
    const generation = ++generationRef.current;
    dispatch({ type: "start", scopeKey });
    return generation;
  }, []);

  const commit = useCallback(
    (
      generation: number,
      action: Exclude<ScopedRequestAction<T>, { type: "start" }>
    ) => {
      if (generation === generationRef.current) dispatch(action);
    },
    []
  );

  return { state, begin, commit };
}

export function resolutionForScope<T>(
  state: ScopedRequestState<T>,
  scopeKey: string | null
): ScopedRequestResolution<T> {
  return state.scopeKey === scopeKey && scopeKey !== null
    ? state.resolution
    : LOADING_RESOLUTION;
}
