/**
 * React hooks for EventStore integration.
 *
 * In the Rust EventStore architecture, event data flows through Jotai atoms
 * fed by snapshot pushes from Rust. These hooks provide convenient selectors
 * over the atom-based state for components that need derived slices.
 */
import { useAtomValue } from "jotai";
import { useMemo, useRef } from "react";

import { eventStoreVersionAtom, eventsAtom } from "../atoms/events";
import type { SessionEvent } from "../types";

// ============================================================================
// Selector hook (derived slices with referential stability)
// ============================================================================

/**
 * Subscribe to a derived slice of the event store.
 * The selector runs on every version bump but the component only re-renders
 * when the selected value changes (compared via `isEqual`).
 *
 * @param selector  Pure function: (events, version) => DerivedValue
 * @param isEqual   Equality check (default: `===`). Use `shallowEqual`
 *                  for arrays/objects.
 */
export function useEventStoreSelector<T>(
  selector: (events: ReadonlyArray<SessionEvent>, version: number) => T,
  isEqual: (prev: T, next: T) => boolean = Object.is
): T {
  const events = useAtomValue(eventsAtom);
  const version = useAtomValue(eventStoreVersionAtom);
  const prevRef = useRef<{ value: T; version: number } | null>(null);

  return useMemo(() => {
    const prev = prevRef.current;
    if (prev && prev.version === version) {
      return prev.value;
    }

    const nextValue = selector(events, version);

    if (prev && isEqual(prev.value, nextValue)) {
      prev.version = version;
      return prev.value;
    }

    prevRef.current = { value: nextValue, version };
    return nextValue;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- event-store version is the selector clock; callback identity changes must not bypass equality or recompute without a store update
  }, [events, version]);
}
