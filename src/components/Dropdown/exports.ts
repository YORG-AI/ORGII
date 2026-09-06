/**
 * Dropdown Exports
 *
 * Re-exports all dropdown-related components and utilities.
 *
 * @example
 * ```tsx
 * // Import main Dropdown component
 * import Dropdown from "@src/components/Dropdown";
 *
 * // Import base building blocks
 * import {
 *   DropdownPanel,
 *   DropdownItem,
 *   DropdownItemGroup,
 *   DropdownSearch,
 *   DROPDOWN_CLASSES,
 *   DROPDOWN_PANEL,
 *   DROPDOWN_ITEM,
 * } from "@src/components/Dropdown/exports";
 * ```
 */

// Main Dropdown component
export { default as Dropdown } from "./index";

// Shared option types (used by both Dropdown options mode and Select)

// Options renderer (used internally and by Select)
export { default as DropdownOptionsRenderer } from "./DropdownOptionsRenderer";

// Keyboard navigation hook
export { useDropdownKeyboard } from "./useDropdownKeyboard";

// Base building blocks
export { default as DropdownPanel } from "./DropdownPanel";

export { default as DropdownItem, DropdownItemGroup } from "./DropdownItem";

export { default as DropdownSearch } from "./DropdownSearch";

export { default as DropdownSelectedCheck } from "./DropdownSelectedCheck";

// Second-level (submenu) panel geometry
export { clampSubmenuTop, getSubmenuAnchor } from "./submenuLayout";

export { default as DropdownHeader } from "./DropdownHeader";

export { default as DropdownFooter } from "./DropdownFooter";

export { default as DropdownCollapsibleSectionHeader } from "./DropdownCollapsibleSectionHeader";

// Multi-select footer (for Select dropdownRender or custom dropdowns)
export { default as MultiSelectFooter } from "./MultiSelectFooter";

// Design tokens
export {
  DROPDOWN_PANEL,
  DROPDOWN_ITEM,
  DROPDOWN_CLASSES,
  MULTI_SELECT_PANEL_WIDTH,
  MULTI_SELECT_TOKENS,
} from "./tokens";
