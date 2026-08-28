/**
 * SimulatorApps Core Types
 *
 * Defines the shared types for the stateful simulator app framework.
 * Each simulator app (IDE, Messages, Notes, etc.) implements these interfaces
 * to provide consistent replay-aware state management.
 *
 * ARCHITECTURE: Uses SessionEvent from session store (SINGLE SOURCE OF TRUTH)
 */
import type { ComponentType, ReactNode } from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { AppType } from "@src/engines/Simulator/types/appTypes";

// ============================================
// Base State Types
// ============================================

/**
 * Base state that all simulator apps share.
 * Extended by each specific app with its own state properties.
 */
export interface SimulatorAppBaseState {
  /** Current event ID being displayed (from replay) */
  currentEventId: string | null;
  /** All events up to current point in replay (filtered by app categories) */
  appEvents: SessionEvent[];
  /** Selected item ID within the app (e.g., selected file, message) */
  selectedItemId: string | null;
  /** Whether currently in replay mode */
  isReplaying: boolean;
}

/**
 * Entry in a simulator app's list view.
 * Generic structure for items like files, messages, notes, etc.
 */
export interface SimulatorAppEntry {
  /** Unique identifier (usually event_id) */
  entryId: string;
  /** Original event */
  event: SessionEvent;
  /** Whether this is the current event in replay */
  isCurrent: boolean;
  /** Timestamp for display */
  timestamp: string;
}

// ============================================
// App Configuration Types
// ============================================

/**
 * Event category matcher function.
 * Returns true if the event should be handled by this app.
 */
export type EventCategoryMatcher = (eventFunction: string) => boolean;

/**
 * Configuration for registering a simulator app.
 * Each app type registers with its event categories and state derivation logic.
 */
export interface SimulatorAppConfig<
  TState extends SimulatorAppBaseState = SimulatorAppBaseState,
> {
  /** Unique app type ID (matches AppType enum) */
  id: AppType;
  /** Display name for the app */
  name: string;
  /** Icon name (kebab-case glyph id) */
  icon: string;
  /** Function to check if an event belongs to this app */
  matchesEvent: EventCategoryMatcher;
  /** Component to render the app */
  component: ComponentType<SimulatorAppProps<TState>>;
  /** Derive app-specific state from filtered events */
  deriveState: (
    events: SessionEvent[],
    currentEventId: string | null
  ) => Omit<TState, keyof SimulatorAppBaseState>;
}

// ============================================
// Component Props Types
// ============================================

/**
 * Props passed to simulator app components.
 */
export interface SimulatorAppProps<TState = SimulatorAppBaseState> {
  /** Current state derived from events */
  state: TState;
  /** Current event (can be various event formats - will be normalized by the app) */
  currentEvent: unknown;
  /** Selected item ID within the app */
  selectedItemId: string | null;
  /** Select an item by ID (for navigation within the app) */
  onSelectItem: (itemId: string) => void;
  /** Mode */
  mode?: "interactive" | "simulation";
  /** Custom controls to render in header */
  customControls?: ReactNode;
}

// ============================================
// Hook Return Types
// ============================================

/**
 * Options for the useSimulatorAppState hook.
 */
export interface UseSimulatorAppStateOptions<
  TState extends SimulatorAppBaseState,
> {
  /** App configuration */
  config: SimulatorAppConfig<TState>;
  /** Optional: override current event ID (for testing) */
  overrideEventId?: string;
  /**
   * Optional: override the default event source atom (simulatorEventsAtom).
   * Used by the Messages app to include user messages that the simulator
   * event list would otherwise filter out.
   */
  eventsAtomOverride?: import("jotai").Atom<
    import("@src/engines/SessionCore/core/types").SessionEvent[]
  >;
}

/**
 * Return type for the useSimulatorAppState hook.
 */
export interface UseSimulatorAppStateReturn<
  TState extends SimulatorAppBaseState,
> {
  /** Derived app state */
  state: TState;
  /** Current event from session store */
  currentEvent: SessionEvent | null;
  /** Selected item ID within the app */
  selectedItemId: string | null;
  /** Set selected item ID */
  setSelectedItemId: (id: string | null) => void;
  /** Whether in replay mode */
  isReplaying: boolean;
  /** All events that match this app's categories */
  appEvents: SessionEvent[];
  /** Jump to a specific event */
  jumpToEvent: (eventId: string) => void;
}
