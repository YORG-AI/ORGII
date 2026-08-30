/**
 * Simulator App Config Factory
 *
 * Factory for creating SimulatorAppConfig instances with consistent patterns.
 * Uses Rust registry (getAppTypeForTool) as the single source of truth for event matching.
 *
 * ## Benefits
 * - No static event category arrays (uses Rust registry)
 * - Consistent matchesEvent implementation
 * - Reduced boilerplate
 * - Type-safe state derivation
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getAppTypeForTool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";

import type { AppType } from "../../types/appTypes";
import type { SimulatorAppBaseState, SimulatorAppConfig } from "./types";

// ============================================
// Types
// ============================================

/**
 * Configuration for creating a simulator app config.
 * The factory handles event matching via Rust registry.
 */
export interface SimulatorAppFactoryConfig<
  TState extends SimulatorAppBaseState,
> {
  /** App type (matches AppType enum) */
  appType: AppType;
  /** Display name */
  name: string;
  /** Icon name (lucide-era slug) */
  icon: string;
  /**
   * Derive app-specific state from filtered events.
   * Events are pre-filtered to only include events for this app.
   */
  deriveState: (
    events: SessionEvent[],
    currentEventId: string | null
  ) => Omit<TState, keyof SimulatorAppBaseState>;
}

// ============================================
// Factory Function
// ============================================

/**
 * Create a simulator app config using Rust registry for event matching.
 *
 * @example
 * export const BROWSER_APP_CONFIG = defineSimulatorAppConfig({
 *   appType: AppType.BROWSER,
 *   name: "Browser",
 *   icon: "Globe",
 *   deriveState: deriveBrowserState,
 * });
 */
export function defineSimulatorAppConfig<TState extends SimulatorAppBaseState>(
  config: SimulatorAppFactoryConfig<TState>
): Omit<SimulatorAppConfig<TState>, "component"> {
  // Event matcher using Rust registry
  const matchesEvent = (eventFunction: string): boolean => {
    return getAppTypeForTool(eventFunction) === config.appType;
  };

  return {
    id: config.appType,
    name: config.name,
    icon: config.icon,
    matchesEvent,
    deriveState: config.deriveState,
  };
}

// ============================================
// Helper: Common State Derivation Patterns
// ============================================

/**
 * Common interface for operation-based app states.
 * Used by Database, Project Manager, etc.
 */
export interface OperationBasedState<TOperation> extends SimulatorAppBaseState {
  operations: TOperation[];
  selectedOperation: TOperation | null;
}

/**
 * Helper to derive operation-based state.
 * Extracts operations from events and finds the selected one.
 */
export function deriveOperationState<TOperation extends { eventId: string }>(
  events: SessionEvent[],
  currentEventId: string | null,
  extractOperation: (
    event: SessionEvent,
    isCurrent: boolean
  ) => TOperation | null
): { operations: TOperation[]; selectedOperation: TOperation | null } {
  const operations: TOperation[] = [];

  for (const event of events) {
    const isCurrent = event.id === currentEventId;
    const op = extractOperation(event, isCurrent);
    if (op) operations.push(op);
  }

  const selectedOperation =
    operations.find((op) => op.eventId === currentEventId) ??
    operations[operations.length - 1] ??
    null;

  return { operations, selectedOperation };
}
