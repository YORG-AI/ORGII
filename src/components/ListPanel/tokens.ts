/**
 * List Panel Design Tokens
 *
 * Centralized design tokens for list items in split panel layouts.
 * Use these tokens to ensure consistent styling across:
 * - Settings list items
 * - Account list items
 * - Session history items
 * - Inbox message rows
 * - etc.
 */
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

// ==============================================
// Item Tokens (list items)
// ==============================================

export const LIST_ITEM = {
  /** Border radius for items */
  borderRadius: 8,
  borderRadiusClass: "rounded-lg",

  /** Horizontal padding */
  paddingX: 12,
  paddingXClass: "px-3",

  /** Vertical padding */
  paddingY: 10,
  paddingYClass: "py-2.5",

  /** Gap between icon and label */
  gap: 8,
  gapClass: "gap-2",

  /** Font size */
  fontSize: 12,
  fontSizeClass: "text-[12px]",

  /** Font weight */
  fontWeight: 500,
  fontWeightClass: "font-medium",

  /** Default text color */
  textClass: "text-text-1",

  /** Icon color (default/not selected) */
  iconClass: "text-text-1",

  /** Icon color (selected) */
  iconSelectedClass: "text-primary-6",

  /** Hover background */
  hoverBgClass: "hover:bg-surface-hover",

  /** Selected background */
  selectedBgClass: SURFACE_TOKENS.selected,

  /** Selected text color */
  selectedTextClass: "text-primary-6",

  /** Selected hover (maintains selected bg) */
  selectedHoverClass: SURFACE_TOKENS.selectedHover,

  /** Transition */
  transitionClass: "transition-colors",
} as const;

// ==============================================
// Composite Class Strings (for easy use)
// ==============================================

/**
 * Complete class strings for list items
 * Usage: <div className={`${LIST_CLASSES.item} ${isSelected ? LIST_CLASSES.itemSelected : LIST_CLASSES.itemHover}`}>
 */
export const LIST_CLASSES = {
  /** Item base classes */
  item: [
    "flex",
    "items-center",
    "cursor-pointer",
    LIST_ITEM.gapClass,
    LIST_ITEM.paddingXClass,
    LIST_ITEM.paddingYClass,
    LIST_ITEM.borderRadiusClass,
    LIST_ITEM.fontSizeClass,
    LIST_ITEM.fontWeightClass,
    LIST_ITEM.transitionClass,
  ].join(" "),

  /** Item with wider gap (gap-2.5) */
  itemWideGap: [
    "flex",
    "items-center",
    "cursor-pointer",
    "gap-2.5",
    LIST_ITEM.paddingXClass,
    LIST_ITEM.paddingYClass,
    LIST_ITEM.borderRadiusClass,
    LIST_ITEM.fontSizeClass,
    LIST_ITEM.fontWeightClass,
    LIST_ITEM.transitionClass,
  ].join(" "),

  /** Default state (not selected) */
  itemDefault: [LIST_ITEM.textClass, LIST_ITEM.hoverBgClass].join(" "),

  /** Selected state */
  itemSelected: [
    LIST_ITEM.selectedBgClass,
    LIST_ITEM.selectedTextClass,
    LIST_ITEM.selectedHoverClass,
  ].join(" "),

  /** Icon classes (default/not selected) */
  icon: ["shrink-0", LIST_ITEM.iconClass].join(" "),

  /** Icon classes (selected) */
  iconSelected: ["shrink-0", LIST_ITEM.iconSelectedClass].join(" "),
} as const;

// ==============================================
// Helper function
// ==============================================

/**
 * Get item classes based on selected state
 * @param isSelected - Whether the item is selected
 * @param variant - Item variant ('default' | 'wideGap')
 * @returns Combined class string
 */
export function getListItemClasses(
  isSelected: boolean,
  variant: "default" | "wideGap" = "default"
): string {
  const baseClass =
    variant === "wideGap" ? LIST_CLASSES.itemWideGap : LIST_CLASSES.item;
  const stateClass = isSelected
    ? LIST_CLASSES.itemSelected
    : LIST_CLASSES.itemDefault;
  return `${baseClass} ${stateClass}`;
}

/**
 * Get icon classes based on selected state
 * @param isSelected - Whether the item is selected
 * @returns Icon class string
 */
export function getListIconClasses(isSelected: boolean): string {
  return isSelected ? LIST_CLASSES.iconSelected : LIST_CLASSES.icon;
}

// ==============================================
// Section Header Tokens (group labels in list panels)
// ==============================================

export const LIST_PANEL_SECTION_HEADER = {
  /** Base typography: 11px, medium, uppercase, tracking-wide */
  typography: "text-[11px] font-medium uppercase tracking-wide text-text-3",

  /** Horizontal padding only; vertical spacing comes from sectionWithHeader gap */
  paddingFirst: "px-3",

  /** Same as first; section top spacing uses sectionGroupTopSpacing on the parent */
  paddingRest: "px-3",

  /** Combined: first section header */
  first: "px-3 text-[11px] font-medium uppercase tracking-wide text-primary-6",

  /** Combined: subsequent section header */
  rest: "px-3 text-[11px] font-medium uppercase tracking-wide text-primary-6",
} as const;

// ==============================================
// List scroll area (padding between header/search and first item)
// ==============================================

export const LIST_PANEL_SCROLL_AREA = {
  /** Default top padding (pt-2) between header/search and list */
  paddingTopDefault: "pt-2",
  /** No top padding - list starts immediately below search/tabs */
  paddingTopNone: "pt-0",
} as const;

// ==============================================
// Sectioned List Layout (multiple sections with gap)
// ==============================================

export const LIST_PANEL_SECTIONS = {
  /** Outer container: no flex gap; use sectionGroupTopSpacing on following sections */
  container: "flex flex-col gap-0",

  /** Inner wrapper for each section: tight gap between items (no section header) */
  sectionGroup: "flex flex-col gap-0.5",

  /** Section title row + list rows; gap-2 between title and first row */
  sectionWithHeader: "flex flex-col gap-2",

  /** Rows inside a headed section (between list items) */
  sectionGroupItems: "flex flex-col gap-0.5",

  /** Padding-top before a section stacked below another (replaces outer gap-4) */
  sectionGroupTopSpacing: "pt-5",
} as const;

// ==============================================
// Type Exports
// ==============================================

export type ListItemTokens = typeof LIST_ITEM;
