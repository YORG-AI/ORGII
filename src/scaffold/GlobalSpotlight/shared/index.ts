/**
 * Shared Components
 *
 * Base components and utilities shared across GlobalSpotlight and selectors.
 */

// Input component
export { SpotlightInput } from "./SpotlightInput";

// Refresh spin (shared by every pinned "Refresh" action)
export { remainingSpinMs, useRefreshSpin } from "./refreshSpin";

// Types
export type {
  BasePaletteProps,
  SpotlightItem,
  SpotlightItemData,
  StatusType,
} from "./types";
