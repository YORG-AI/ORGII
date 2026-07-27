/**
 * Dropdown Hooks
 *
 * Shared hooks for dropdown behavior across the application.
 *
 * - useDropdownEngine: Unified base hook (single source of truth for
 *   positioning, ESC, click-outside, and keyboard navigation).
 * - useDropdownListNavigation: Typed list navigation slice (Arrow/Enter
 *   over `items[]`). Wired automatically when `useDropdownEngine` is
 *   called with `listNavigation`.
 * - useDropdownAutoKeyboard: DOM auto-discover keyboard fallback. Wired
 *   automatically by `useDropdownEngine` when `listNavigation` is not
 *   provided.
 * - getDropdownPanelStyle: turns the engine's `panelPosition` into the
 *   panel's inline style (flip side, alignment, width, max height).
 */

export {
  getDropdownPanelStyle,
  type DropdownPanelStyleOptions,
} from "./dropdownPanelStyle";

export {
  useDropdownEngine,
  type DropdownEnginePosition,
  type UseDropdownEngineOptions,
  type UseDropdownEngineReturn,
} from "./useDropdownEngine";

export {
  useDropdownListNavigation,
  type UseDropdownListNavigationOptions,
  type UseDropdownListNavigationReturn,
} from "./useDropdownListNavigation";

export {
  useDropdownAutoKeyboard,
  type UseDropdownAutoKeyboardOptions,
} from "./useDropdownAutoKeyboard";
