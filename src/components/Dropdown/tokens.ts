/**
 * Dropdown Design Tokens
 *
 * Centralized design tokens for all dropdown/select components.
 * Use these tokens to ensure consistent styling across:
 * - Select
 * - Dropdown
 * - Menu
 * - DropdownPill
 * - ContextMenu
 * - etc.
 */

// ==============================================
// Panel Tokens (dropdown container)
// ==============================================

export const DROPDOWN_PANEL = {
  /** Border radius for dropdown panels */
  borderRadius: 8,
  borderRadiusClass: "rounded-lg",

  /** Box shadow - light mode */
  shadow: "0 4px 16px rgba(0, 0, 0, 0.12), 0 2px 4px rgba(0, 0, 0, 0.08)",
  shadowClass: "shadow-dropdown",

  /** Box shadow - dark mode */
  shadowDark: "0 4px 16px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3)",

  /** z-index for dropdown panels — must exceed Spotlight's containerZIndex (9999) */
  zIndex: 10000,
  zIndexClass: "z-[10000]",

  /** Panel padding (no header) */
  padding: 4,
  paddingClass: "p-1",

  /**
   * Items-container padding when the panel ALSO renders a `sectionLabel`
   * header above. The header already supplies vertical breathing room, so
   * the items wrapper drops `pt-*` and keeps only `px-1 pb-1` to avoid the
   * doubled gap between header text and the first item.
   */
  paddingBelowHeaderClass: "px-1 pb-1",

  /** Default min width for menu panels. */
  menuMinWidthClass: "min-w-[140px]",

  /** Max height for the panel itself */
  maxHeight: 256,
  maxHeightClass: "max-h-64",

  /** Max height for scrollable options inside a panel with search/header.
   *  Shorter than maxHeight so scroll triggers before outer overflow-hidden clips. */
  optionsMaxHeight: 200,
  optionsMaxHeightClass: "max-h-[200px]",

  /** Gap between trigger and dropdown (px). Default for useDropdownEngine. */
  triggerGap: 4,
  /** Gap between primary dropdown and second-level submenu/flyout panels. */
  submenuGap: 8,
  /** Tight gap for sidebar tab lists and inline menus */
  triggerGapTight: 4,

  /** Gap between dropdown items (px). gap-0.5 = 2px. */
  itemsGap: 2,
  itemsGapClass: "gap-0.5",

  /** Animation duration */
  animationDuration: "0.2s",

  /** Background and border (use Tailwind classes) */
  bgClass: "bg-bg-2",
  borderClass: "border border-solid border-border-2",
} as const;

// ==============================================
// Item Tokens (menu items/options)
// ==============================================

export const DROPDOWN_ITEM = {
  /** Border radius for items */
  borderRadius: 6,
  borderRadiusClass: "rounded-md",

  /** Row height */
  height: 32,
  heightClass: "h-8",
  minHeightClass: "min-h-8",

  /** Horizontal padding */
  paddingX: 6,
  paddingXClass: "px-1.5",

  /** Vertical padding is zero because the row height is fixed at 32px. */
  paddingY: 0,
  paddingYClass: "py-0",

  /** Gap between icon and label */
  gap: 8,
  gapClass: "gap-2",

  /** Icon size */
  iconSize: 13,
  iconSizeClass: "h-[13px] w-[13px]",

  /** Font size */
  fontSize: 13,
  fontSizeClass: "text-[13px]",

  /**
   * Hover background. Hover only changes the surface fill — the selected
   * state owns the `primary-6` text color + checkmark, and mixing the two
   * (blue text on every hovered row) makes every row look selected.
   */
  hoverBgClass: "hover:bg-surface-hover",

  /**
   * Selected background — intentionally transparent. The selected state is
   * communicated by a checkmark and primary-6 text only; keyboard hover is
   * the only filled state in dropdowns.
   */
  selectedBgClass: "bg-transparent",

  /** Selected text color */
  selectedTextClass: "!text-primary-6",

  /** Disabled opacity */
  disabledOpacity: 0.5,
  disabledClass: "opacity-50 cursor-not-allowed",

  /** Transition */
  transitionClass: "transition-colors duration-150",
} as const;

// ==============================================
// Search Input Tokens
// ==============================================

export const DROPDOWN_SEARCH = {
  /** Height */
  height: 32,
  heightClass: "h-8",

  /** Padding */
  paddingX: 12,
  paddingXClass: "px-3",

  /** Border radius */
  borderRadius: 6,
  borderRadiusClass: "rounded-md",

  /** Font size */
  fontSize: 13,
  fontSizeClass: "text-[13px]",

  /** Icon size */
  iconSize: 13,
} as const;

// ==============================================
// Composite Class Strings (for easy use)
// ==============================================

/**
 * Complete class string for dropdown panel container
 * Usage: <div className={DROPDOWN_CLASSES.panel}>...</div>
 */
export const DROPDOWN_CLASSES = {
  /** Panel container classes */
  panel: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.zIndexClass,
    "shadow-dropdown",
    "overflow-hidden",
  ].join(" "),

  /** Panel with animation */
  panelAnimated: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.zIndexClass,
    "shadow-dropdown",
    "overflow-hidden",
    "animate-dropdown-in",
  ].join(" "),

  /** Scrollable options container (scrollbar hidden) */
  optionsContainer: [
    "flex flex-col",
    "cursor-default",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingClass,
    DROPDOWN_PANEL.maxHeightClass,
    "overflow-y-auto",
    "scrollbar-hide",
  ].join(" "),

  /** Scrollable options container when a `sectionLabel` header sits above. */
  optionsContainerBelowHeader: [
    "flex flex-col",
    "cursor-default",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingBelowHeaderClass,
    DROPDOWN_PANEL.maxHeightClass,
    "overflow-y-auto",
    "scrollbar-hide",
  ].join(" "),

  /** Scrollable options container (visible scrollbar, e.g. table selector, timezone) */
  optionsContainerScrollbar: [
    "flex flex-col",
    "cursor-default",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingClass,
    DROPDOWN_PANEL.maxHeightClass,
    "overflow-y-auto",
    "dropdown-options-scrollbar",
  ].join(" "),

  /** Scrollable options container with overlay scrollbar and caller-owned max height. */
  optionsContainerOverlay: [
    "scrollbar-overlay",
    "flex",
    "flex-col",
    "overflow-y-auto",
    DROPDOWN_PANEL.paddingClass,
    DROPDOWN_PANEL.itemsGapClass,
  ].join(" "),

  /** Scrollable options container (visible scrollbar) when a header sits above. */
  optionsContainerScrollbarBelowHeader: [
    "flex flex-col",
    "cursor-default",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingBelowHeaderClass,
    DROPDOWN_PANEL.maxHeightClass,
    "overflow-y-auto",
    "dropdown-options-scrollbar",
  ].join(" "),

  /** Standard 32px dropdown row. */
  item: [
    "flex",
    "items-center",
    DROPDOWN_ITEM.gapClass,
    DROPDOWN_ITEM.paddingXClass,
    DROPDOWN_ITEM.heightClass,
    DROPDOWN_ITEM.minHeightClass,
    DROPDOWN_ITEM.paddingYClass,
    DROPDOWN_ITEM.borderRadiusClass,
    DROPDOWN_ITEM.fontSizeClass,
    DROPDOWN_ITEM.transitionClass,
    "cursor-pointer",
    "text-text-1",
  ].join(" "),

  /** Item hover state */
  itemHover: DROPDOWN_ITEM.hoverBgClass,

  /** Active row background for keyboard/hover-index highlight without selected text styling. */
  itemActive: "bg-surface-hover",

  /** Item selected state */
  itemSelected: [
    DROPDOWN_ITEM.selectedBgClass,
    DROPDOWN_ITEM.selectedTextClass,
    "hover:bg-surface-hover",
    "hover:!text-primary-6",
  ].join(" "),

  /** Item disabled state */
  itemDisabled: DROPDOWN_ITEM.disabledClass,

  /** Widthless menu panel base. Pair with one DROPDOWN_WIDTHS token. */
  menuPanelBase: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.shadowClass,
    DROPDOWN_PANEL.paddingClass,
    DROPDOWN_PANEL.zIndexClass,
  ].join(" "),

  /** Menu panel that sizes to single-line action content. */
  menuPanel: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.shadowClass,
    DROPDOWN_PANEL.paddingClass,
    DROPDOWN_PANEL.zIndexClass,
    DROPDOWN_PANEL.menuMinWidthClass,
    "w-max",
  ].join(" "),

  /** Widthless menu panel base with a full-width header/search row. Pair with one DROPDOWN_WIDTHS token. */
  menuPanelWithHeaderBase: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.shadowClass,
    DROPDOWN_PANEL.zIndexClass,
    "overflow-hidden",
  ].join(" "),

  /** Menu panel with a full-width header/search row. */
  menuPanelWithHeader: [
    DROPDOWN_PANEL.bgClass,
    DROPDOWN_PANEL.borderClass,
    DROPDOWN_PANEL.borderRadiusClass,
    DROPDOWN_PANEL.shadowClass,
    DROPDOWN_PANEL.zIndexClass,
    DROPDOWN_PANEL.menuMinWidthClass,
    "w-max",
    "overflow-hidden",
  ].join(" "),

  /** Full-width 32px menu action item that keeps labels on one line. */
  menuActionItem: [
    "flex",
    "w-full",
    "items-center",
    "justify-start",
    "whitespace-nowrap",
    "text-left",
    DROPDOWN_ITEM.gapClass,
    DROPDOWN_ITEM.paddingXClass,
    DROPDOWN_ITEM.heightClass,
    DROPDOWN_ITEM.minHeightClass,
    DROPDOWN_ITEM.paddingYClass,
    DROPDOWN_ITEM.borderRadiusClass,
    DROPDOWN_ITEM.fontSizeClass,
    DROPDOWN_ITEM.transitionClass,
    "cursor-pointer",
    "text-text-1",
    DROPDOWN_ITEM.hoverBgClass,
  ].join(" "),

  /** 32px menu row for label + right-side control such as Switch. */
  menuControlItem: [
    "flex",
    "w-full",
    "items-center",
    "justify-between",
    "whitespace-nowrap",
    "text-left",
    DROPDOWN_ITEM.gapClass,
    DROPDOWN_ITEM.paddingXClass,
    DROPDOWN_ITEM.heightClass,
    DROPDOWN_ITEM.minHeightClass,
    DROPDOWN_ITEM.paddingYClass,
    DROPDOWN_ITEM.borderRadiusClass,
    DROPDOWN_ITEM.fontSizeClass,
    DROPDOWN_ITEM.transitionClass,
    "text-text-1",
    DROPDOWN_ITEM.hoverBgClass,
  ].join(" "),

  /** Separator between menu groups. */
  menuSeparator: ["border-t", "border-solid", "border-border-2"].join(" "),

  /** Inset separator between dropdown list groups. */
  menuSeparatorInset: [
    "mx-1.5",
    "my-1",
    "border-t",
    "border-solid",
    "border-border-2",
  ].join(" "),

  /** Search input container */
  searchContainer: [
    "flex",
    "shrink-0",
    "items-center",
    DROPDOWN_ITEM.gapClass,
    "px-3",
    "py-1.5",
    "border-b",
    "border-solid",
    "border-border-2",
  ].join(" "),

  /** Search input */
  searchInput: [
    "flex-1",
    "bg-transparent",
    "border-none",
    "outline-none",
    DROPDOWN_ITEM.fontSizeClass,
    "text-text-1",
    "placeholder:text-text-3",
  ].join(" "),

  /** Column wrapper for dropdown items (flex + items gap). Use when stacking items without optionsContainer. */
  itemsColumn: ["flex flex-col", DROPDOWN_PANEL.itemsGapClass].join(" "),

  /** Padded column wrapper for non-scroll dropdown item stacks. */
  itemsColumnPadded: [
    "flex flex-col",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingClass,
  ].join(" "),

  /**
   * Column wrapper + padding for items rendered directly under a
   * `sectionLabel` header — drops top padding so the gap between header
   * and first item matches the visual spec.
   */
  itemsColumnBelowHeader: [
    "flex flex-col",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingBelowHeaderClass,
  ].join(" "),

  /** Item column directly under a full-width search/header row. */
  itemsColumnBelowSearch: [
    "flex flex-col",
    DROPDOWN_PANEL.itemsGapClass,
    DROPDOWN_PANEL.paddingClass,
  ].join(" "),

  /** Section / group label inside a dropdown (non-interactive). */
  sectionLabel:
    "px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-3",

  /** Bordered dropdown section wrapper for grouped controls above/between lists. */
  sectionContainer: [
    "border-b",
    "border-solid",
    "border-border-2",
    DROPDOWN_PANEL.paddingClass,
  ].join(" "),

  /** Empty/loading message inside a dropdown list. */
  listMessage:
    "flex items-center justify-center gap-2 px-3 py-6 text-center text-[13px] text-text-3",

  /** Footer container (Select All, actions) — flex, border-t, p-1 */
  footerContainer: [
    "flex",
    "shrink-0",
    "items-center",
    "gap-2",
    "border-t",
    "border-solid",
    "border-border-2",
    DROPDOWN_PANEL.paddingClass,
  ].join(" "),
} as const;

// ==============================================
// Width Tokens
// ==============================================

export const DROPDOWN_WIDTHS = {
  /** Menu/list dropdown — channel selector, etc. */
  menuClass: "min-w-[140px]",
  /** Sidebar tab list, inline menu — Project/History switcher, etc. */
  sidebarMenuClass: "min-w-[180px]",
  /** Wide menu — status bar, model selector, trajectory */
  wideMenuClass: "min-w-[200px]",
  /** Panel dropdown — info popover, tooltip panel */
  panelWidthClass: "min-w-[220px]",
  /** File tree dropdown, multi-select panels */
  fileTreeClass: "min-w-[280px]",
} as const;

/** Minimum width (px) for multi-select dropdown panels */
export const MULTI_SELECT_PANEL_WIDTH = 280;

export const MULTI_SELECT_TOKENS = {
  /** Max tags shown before truncating to +X (keeps single line) */
  maxTagCount: 2,
  /** Select All / Unselect All button in footer */
  footerSelectAll: "text-xs text-text-2 hover:text-text-1 cursor-pointer",
} as const;

// ==============================================
// Style Objects (for inline styles when needed)
// ==============================================

export const DROPDOWN_STYLES = {
  /** Panel shadow style */
  panelShadow: {
    boxShadow: DROPDOWN_PANEL.shadow,
  },

  /** Panel shadow style (dark mode) */
  panelShadowDark: {
    boxShadow: DROPDOWN_PANEL.shadowDark,
  },

  /** Dropdown animation keyframes (for CSS-in-JS) */
  animation: {
    from: {
      opacity: 0,
      transform: "translateY(-8px)",
    },
    to: {
      opacity: 1,
      transform: "translateY(0)",
    },
  },
} as const;

// ==============================================
// Type Exports
// ==============================================

export type DropdownPanelTokens = typeof DROPDOWN_PANEL;
export type DropdownItemTokens = typeof DROPDOWN_ITEM;
export type DropdownSearchTokens = typeof DROPDOWN_SEARCH;
