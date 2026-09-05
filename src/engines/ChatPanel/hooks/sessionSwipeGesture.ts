/**
 * Pure state machine behind two-finger horizontal swipe navigation in the
 * chat pane. Wheel deltas accumulate into a gesture; once the run crosses the
 * trigger distance the tab navigates exactly once, and the gesture stays
 * consumed until the trackpad has gone quiet (so inertial tail events cannot
 * re-trigger). Direction follows the macOS convention: fingers moving right
 * (negative deltaX) go back, fingers moving left go forward.
 */
export type SwipeDirection = "back" | "forward";

export interface SwipeGestureState {
  direction: SwipeDirection | null;
  /** Accumulated horizontal travel in the current direction, px. */
  distance: number;
  /** A navigation already fired for this gesture. */
  consumed: boolean;
  lastAt: number;
}

export interface SwipeWheelInput {
  deltaX: number;
  deltaY: number;
  now: number;
}

export interface SwipeAvailability {
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface SwipeReduceResult {
  state: SwipeGestureState;
  trigger: SwipeDirection | null;
}

/** Travel before the indicator starts showing; filters diagonal jitter. */
export const SWIPE_START_DISTANCE = 24;
/** Travel at which the navigation fires. */
export const SWIPE_TRIGGER_DISTANCE = 220;
/** Quiet time after which the next wheel event starts a fresh gesture. */
export const SWIPE_IDLE_RESET_MS = 350;

export const IDLE_SWIPE_STATE: SwipeGestureState = {
  direction: null,
  distance: 0,
  consumed: false,
  lastAt: 0,
};

export function resolveSwipeDirection(deltaX: number): SwipeDirection {
  return deltaX < 0 ? "back" : "forward";
}

/** 0..1 share of the trigger distance covered, after the start threshold. */
export function resolveSwipeProgress(distance: number): number {
  const span = SWIPE_TRIGGER_DISTANCE - SWIPE_START_DISTANCE;
  return Math.min(1, Math.max(0, (distance - SWIPE_START_DISTANCE) / span));
}

export function reduceSwipeWheel(
  state: SwipeGestureState,
  { deltaX, deltaY, now }: SwipeWheelInput,
  availability: SwipeAvailability
): SwipeReduceResult {
  const idle = now - state.lastAt > SWIPE_IDLE_RESET_MS;
  const base = idle ? IDLE_SWIPE_STATE : state;

  // Vertical or dead-zone motion never contributes; it only keeps a live
  // gesture from being treated as idle.
  if (deltaX === 0 || Math.abs(deltaX) < Math.abs(deltaY)) {
    return { state: { ...base, lastAt: now }, trigger: null };
  }

  if (base.consumed) {
    return { state: { ...base, lastAt: now }, trigger: null };
  }

  const direction = resolveSwipeDirection(deltaX);
  const allowed =
    direction === "back" ? availability.canGoBack : availability.canGoForward;
  if (!allowed) {
    return {
      state: { ...IDLE_SWIPE_STATE, lastAt: now },
      trigger: null,
    };
  }

  const distance =
    base.direction === direction
      ? base.distance + Math.abs(deltaX)
      : Math.abs(deltaX);
  if (distance >= SWIPE_TRIGGER_DISTANCE) {
    return {
      state: {
        direction,
        distance: SWIPE_TRIGGER_DISTANCE,
        consumed: true,
        lastAt: now,
      },
      trigger: direction,
    };
  }
  return {
    state: { direction, distance, consumed: false, lastAt: now },
    trigger: null,
  };
}

/**
 * True when some horizontally scrollable ancestor (a code block, a wide
 * table) can still absorb this wheel delta itself — the swipe must never
 * steal a scroll the content wanted.
 */
export function canAncestorScrollHorizontally(
  target: Element | null,
  boundary: Element,
  deltaX: number
): boolean {
  let element: Element | null = target;
  while (element && element !== boundary) {
    if (element instanceof HTMLElement) {
      const { overflowX } = getComputedStyle(element);
      const scrollable =
        (overflowX === "auto" || overflowX === "scroll") &&
        element.scrollWidth > element.clientWidth + 1;
      if (scrollable) {
        const atStart = element.scrollLeft <= 0;
        const atEnd =
          element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
        if (deltaX < 0 && !atStart) return true;
        if (deltaX > 0 && !atEnd) return true;
      }
    }
    element = element.parentElement;
  }
  return false;
}
