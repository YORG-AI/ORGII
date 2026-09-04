/**
 * Simulator Apps — Core Framework
 *
 * Pure framework: types, matchers, and the state hook.
 * The registry and renderer live in WorkStation/shared/simulatorRegistry/.
 */

// Core exports (types, matchers, state hook)
export * from "./core";

// Re-export commonly used types for convenience
export type {
  SimulatorAppBaseState,
  SimulatorAppConfig,
  SimulatorAppProps,
} from "./core/types";
