/**
 * Shared Components
 *
 * Base components and utilities shared across GlobalSpotlight and selectors.
 */

// Input component
export { SpotlightInput } from "./SpotlightInput";
export type { SpotlightInputProps } from "./SpotlightInput";

// Refresh spin (shared by every pinned "Refresh" action)
export {
  REFRESH_SPIN_MIN_MS,
  remainingSpinMs,
  useRefreshSpin,
} from "./refreshSpin";
export type { RefreshSpinIconProps, UseRefreshSpinReturn } from "./refreshSpin";

// Types
export type {
  BasePaletteProps,
  SpotlightItem,
  SpotlightItemData,
  StatusType,
} from "./types";
