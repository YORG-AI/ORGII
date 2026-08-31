/**
 * SimulatorApps Core — Pure Framework
 *
 * Types, matchers, config factory, and the state hook for the simulator app framework.
 * The registry and renderer live in WorkStation/shared/simulatorRegistry/.
 */

// Types
export type {
  SimulatorAppBaseState,
  SimulatorAppConfig,
  SimulatorAppProps,
} from "./types";

// Hook
export { useSimulatorAppState } from "./useSimulatorAppState";

// Matchers (standalone to avoid circular deps)
export { matchesByAppType } from "./matchers";

// Config factory
export { defineSimulatorAppConfig } from "./configFactory";
