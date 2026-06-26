/**
 * WorkStation Header Tokens
 *
 * Centralized header dimensions, button styles, and class strings for Workstation.
 * Follows the same pattern as DROPDOWN_CLASSES in @src/components/Dropdown/tokens.
 *
 * Used by: FileHeader, WebUrlBar, SearchBar,
 *          CollapsibleSection, PanelSectionHeader, ActionBar, IconButton, etc.
 */
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

/** Orgii Editor tab canvas — matches CodeMirror (--cm-editor-background on :root). */
export const EDITOR_TAB_CANVAS_BG_CLASS = "bg-[var(--cm-editor-background)]";

/** Primary sidebar panel background — compact (docked) layout. */
export const PRIMARY_SIDEBAR_SURFACE_BG_CLASS = "bg-workstation-bg";

/** Primary sidebar + sticky header background — comfort (floating) layout. */
export const PRIMARY_SIDEBAR_COMFORT_SURFACE_BG_CLASS =
  EDITOR_TAB_CANVAS_BG_CLASS;

/** Full-area empty / loading surfaces outside the main no-tabs placeholder. */
export const WORK_STATION_PLACEHOLDER_PAGE_BG_CLASS = "bg-pane-raised";

export const PRIMARY_SIDEBAR_HOVER = {
  row: SURFACE_TOKENS.hover,
  selectedRow: SURFACE_TOKENS.selectedHover,
} as const;

// ============================================
// Dimensions
// ============================================

/** Standard header height (px) for all Workstation headers */
export const HEADER_HEIGHT = 40;

/** Icon sizes used inside header buttons */
export const HEADER_ICON_SIZE = {
  /** Standard icon size (14px) — section headers, file headers, action bars */
  sm: 14,
  /** Larger icon size (16px) — bottom panel, URL bar, tab bar */
  md: 16,
} as const;

// ============================================
// Button Tokens
// ============================================

/** Base class shared by all icon-only header buttons */
const BUTTON_BASE =
  "flex items-center justify-center rounded transition-colors";

/** Size classes for icon-only buttons */
export const BUTTON_SIZE = {
  /** 20×20 — standard header / row action button (single source of truth) */
  sm: "h-5 w-5",
  /** 24×24 — larger header action button */
  md: "h-6 w-6",
  /** 28×28 — collapse toggles, modal headers */
  lg: "h-7 w-7",
} as const;

/** Variant classes for icon-only buttons */
export const BUTTON_VARIANT = {
  /** Default: muted text, hover shows fill background (use outside tree rows) */
  default: `text-text-3 ${SURFACE_TOKENS.hover} hover:text-text-1`,
  /** Default for tree rows / section headers — parent row uses shared hover, so the button steps up to the button-hover surface. */
  defaultTreeRow: "text-text-3 hover:bg-button-hover hover:text-text-1",
  /** Danger: muted text, hover shows danger background */
  danger: "text-text-3 hover:bg-danger-1 hover:text-danger-6",
  /** Success: muted text, hover shows success background */
  success: "text-text-3 hover:bg-success-1 hover:text-success-6",
  /** Active/toggled: primary highlight with selected surface; hover steps up over selected rows. */
  active: `${SURFACE_TOKENS.selected} text-primary-6 hover:bg-button-hover`,
} as const;

/**
 * Pre-composed button class strings for direct use in JSX.
 *
 * Usage:
 * ```tsx
 * <button className={HEADER_BUTTON.action} title="Refresh">
 *   <RefreshCw size={HEADER_ICON_SIZE.sm} />
 * </button>
 *
 * <button className={HEADER_BUTTON.actionDisabled} disabled={!canClick}>
 *   <ArrowLeft size={HEADER_ICON_SIZE.md} />
 * </button>
 * ```
 */
const HEADER_BUTTON_SM_TREEROW = `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.defaultTreeRow}`;

export const HEADER_BUTTON = {
  /** Standard action button (20×20, default variant) */
  action: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.default}`,
  /** Standard for tree rows & section headers — hover fill-3 over shared row hover */
  actionTreeRow: HEADER_BUTTON_SM_TREEROW,
  /** Standard action button with disabled support */
  actionDisabled: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.default} disabled:cursor-not-allowed disabled:opacity-30`,
  /** Danger action button (20×20) */
  danger: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.danger}`,
  /** Success action button (20×20) — merge, accept, run test */
  success: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.success}`,
  /** Active/toggled button (20×20) */
  active: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.active}`,
  /** Medium (24×24) — modal close, etc. */
  actionMd: `${BUTTON_BASE} ${BUTTON_SIZE.md} ${BUTTON_VARIANT.default}`,
  /** Md for tree rows — hover fill-3 over shared row hover */
  actionMdTreeRow: `${BUTTON_BASE} ${BUTTON_SIZE.md} ${BUTTON_VARIANT.defaultTreeRow}`,
  /** Large (28×28) — collapse toggles, panel headers */
  actionLg: `${BUTTON_BASE} ${BUTTON_SIZE.lg} ${BUTTON_VARIANT.default}`,
  /**
   * Workstation tab bar trailing slot — regular header action styling.
   * Prefer this name in tab-strip code for clarity.
   */
  tabBarTrailing: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${BUTTON_VARIANT.default}`,
  /** Tab bar trailing — toggled on (e.g. split view, properties panel) */
  tabBarTrailingActive: `${BUTTON_BASE} ${BUTTON_SIZE.sm} ${SURFACE_TOKENS.selected} text-primary-6 ${SURFACE_TOKENS.selectedHover}`,
} as const;

// ============================================
// Tab bar trailing strip (document tabs row)
// ============================================

/**
 * Flex row for right-side tab bar controls (before horizontal padding).
 * Pair with {@link TAB_BAR_CONTROLS_ROW_PADDING_FULL} or
 * {@link TAB_BAR_CONTROLS_ROW_PADDING_TRAILING_ONLY}.
 */
export const TAB_BAR_CONTROLS_ROW_BASE_CLASS =
  "ml-auto flex h-full shrink-0 items-center gap-px";

/** Full inset when built-in buttons exist or when document tabs are shown. */
export const TAB_BAR_CONTROLS_ROW_PADDING_FULL = "pl-1 pr-2";

/**
 * Trailing-only row (e.g. Code Editor with zero tabs: bottom-panel toggle).
 * Matches the standard tab-bar trailing edge inset.
 */
export const TAB_BAR_CONTROLS_ROW_PADDING_TRAILING_ONLY = "pl-1 pr-2";

/** Default: full horizontal padding (most toolbars). */
export const TAB_BAR_CONTROLS_ROW_CLASS = `${TAB_BAR_CONTROLS_ROW_BASE_CLASS} ${TAB_BAR_CONTROLS_ROW_PADDING_FULL}`;

/**
 * Trailing icon group **inside** `TAB_BAR_CONTROLS_ROW_CLASS` (or inside
 * {@link TAB_BAR_TRAILING_EDGE_CLASS}). Do not add horizontal padding here —
 * the parent supplies the tab-bar edge inset.
 */
export const TAB_BAR_TRAILING_CLUSTER_CLASS =
  "flex h-full shrink-0 items-center gap-px";

/**
 * Trailing block at the end of a tab bar **without** `TabBarControls` (e.g.
 * {@link ReplayTabBar}) — matches the controls row’s horizontal padding only.
 */
export const TAB_BAR_TRAILING_EDGE_CLASS =
  "flex h-full shrink-0 items-center gap-px pl-1 pr-2";

// ============================================
// Split Button Tokens
// ============================================
/**
 * Split action button: primary click + chevron dropdown.
 * Used by: terminal "new + profile picker", any action with a dropdown variant.
 *
 * Hover behaviour (each half is independent):
 *  - Left hover  → shared surface hover, icon → text-text-1
 *  - Right hover → bg-fill-3, icon → text-text-1
 *
 * ```tsx
 * <div className={SPLIT_BUTTON.container}>
 *   <button className={SPLIT_BUTTON.left} onClick={onDefault}>
 *     <Plus size={HEADER_ICON_SIZE.md} />
 *   </button>
 *   <button className={SPLIT_BUTTON.right} onClick={onToggleMenu}>
 *     <ChevronDown size={12} />
 *   </button>
 * </div>
 * ```
 */
export const SPLIT_BUTTON = {
  /** Outer wrapper — shared surface hover covers both halves */
  container: `group/split flex items-center rounded transition-colors ${SURFACE_TOKENS.hover}`,
  /** Left (primary action) — inherits the shared hover surface from container */
  left: "flex h-5 w-5 items-center justify-center rounded-l text-text-3 transition-colors group-hover/split:text-text-1",
  /** Right (chevron) — button hover surface stacks on top of container hover */
  right:
    "flex h-5 items-center justify-center rounded-r px-0.5 text-text-3 transition-colors group-hover/split:text-text-1 hover:bg-button-hover",
} as const;

// ============================================
// Header Class Strings
// ============================================

/** Shared 40px file-bar row geometry (used by FileHeader + search rows). */
export const FILE_BAR_ROW_CLASSES =
  "work-station-file-bar flex h-[40px] flex-shrink-0 items-center gap-1.5 px-2";

export const HEADER_CLASSES = {
  /**
   * File bar header (top bar showing file path / URL / preview info).
   * Used by: FileHeader, WebUrlBar
   *
   * Height: 40px, horizontal layout, shrink-proof, 8px left / 4px right padding.
   */
  fileBar: FILE_BAR_ROW_CLASSES,

  /**
   * Page-level header (bordered, with background).
   * Used by: ProjectsPageHeader, WorkItemsPageHeader
   *
   * Height: 40px, bottom border, 12px horizontal padding.
   */
  pageHeader:
    "flex h-[40px] flex-shrink-0 items-center gap-2 border-b border-border-2 px-3",

  /**
   * Section title header (inline title for property groups, no border/bg).
   * Used by: PropertiesPanel, WorkItemProperties, WorkItemsOverview
   *
   * Height: 40px, transparent background, 12px horizontal padding.
   */
  sectionTitle: "flex h-[40px] flex-shrink-0 items-center gap-2 px-4",

  /**
   * Sidebar section header (collapsible section title row).
   * Used by: CollapsibleSection, PanelSectionHeader
   *
   * Height: 32px, space-between layout, shrink-proof, transparent surface.
   */
  sectionHeader:
    "flex h-8 min-w-0 flex-shrink-0 items-center justify-between overflow-hidden bg-transparent pl-3 pr-2",
} as const;

/**
 * Search tab row layout (used by Search editor + Extension tab search rows).
 * Keeps height/border/padding consistent across tabs.
 */
export const SEARCH_TAB_ROW_CLASSES = {
  /** Row container: fixed row height + horizontal layout + padding */
  row: FILE_BAR_ROW_CLASSES,
  /** Optional bottom divider */
  withBorder: "border-b border-border-2",
} as const;

// ============================================
// Typography Tokens
// ============================================
// Matches UI Design Standards (ui-design-standards-0106.md)

export const TYPOGRAPHY = {
  /** Section titles, panel headers — 13px medium */
  sectionTitle: "text-[13px] font-medium",
  /** Field labels, property names — 12px normal */
  label: "text-[12px] font-normal",
  /** Field values, body content — 12px normal */
  value: "text-[12px] font-normal",
  /** Emphasized values — 12px medium */
  valueMedium: "text-[12px] font-medium",
  /** Numeric stats, card numbers — 14px semibold */
  statistic: "text-[14px] font-semibold",
  /** Helper text, timestamps, badges — 11px normal */
  secondary: "text-[11px] font-normal",
  /** Panel placeholders (sidebar) — 12px normal */
  panelTitle: "text-[12px]",
  /** Panel subtitle — 11px */
  panelSubtitle: "text-[11px]",
  /** Content placeholders (main area) — 14px bold */
  contentTitle: "text-[14px] font-medium",
  /** Content subtitle — 12px */
  contentSubtitle: "text-[12px]",
  /** List items, row labels — 13px medium */
  listItem: "text-[13px] font-medium",
  /** Small badges, counts — 10px medium */
  badge: "text-[10px] font-medium",
} as const;

// ============================================
// Count Badge Tokens
// ============================================
/** Used by: SectionHeader (source control), SearchResults (file match count) */

export const COUNT_BADGE = {
  /** Base: flex, centered, rounded-full, 18px height, 11px font */
  base: "flex h-[18px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-medium",
  /** Single digit (0–9): 18×18 square */
  sizeSingle: "w-[18px]",
  /** Multi digit (10+): min width with padding */
  sizeMulti: "min-w-[18px] px-1.5",
  /** Primary variant (source control, search) */
  primary: "bg-primary-5 text-white",
  /** Muted variant for zero-count section badges */
  muted: "bg-fill-2 text-text-3",
  /** Warning variant (merge conflicts) */
  warning: "bg-warning-5 text-white",
  /** Danger variant (merge conflicts, destructive counts) */
  danger: "bg-danger-5 text-white",
} as const;

/** Returns size class for count badge (18×18 for single digit, expandable for multi) */
export function getCountBadgeSizeClass(count: number): string {
  return count < 10 ? COUNT_BADGE.sizeSingle : COUNT_BADGE.sizeMulti;
}

// ============================================
// Section Action Button Tokens
// ============================================
/** Used by: CollapsibleSection (PrimarySidebarLayout) */

// ============================================
// Diff Stats Tokens
// ============================================
/** +N / -N inline stats shown in file headers and commit headers */

export const DIFF_STATS = {
  /** Container: inline flex, shrink-proof, 12px, padded for header context */
  container:
    "flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px]",
  /** Compact variant for tree rows (11px, no padding) */
  containerCompact: "flex shrink-0 items-center gap-1 text-[11px]",
  /** Additions text */
  additions: "text-success-6",
  /** Deletions text */
  deletions: "text-danger-6",
} as const;

export const SECTION_ACTION_BUTTON = {
  /** Base + primary sidebar hover variant. */
  base: `flex items-center justify-center rounded transition-colors ${BUTTON_VARIANT.defaultTreeRow}`,
  /** Icon-only (20×20) */
  iconOnly: "h-5 w-5",
  /** With label (compact inline) */
  withLabel: "gap-1 px-1.5 py-0.5 text-[11px]",
} as const;

// ============================================
// Multi-Root Folder Header Tokens
// ============================================

export const FOLDER_HEADER = {
  /** Outer wrapper for a folder section */
  section: "flex flex-col",
  /** Header row: named group for row-local hover-reveal actions */
  row: `group/folder-header flex h-7 flex-shrink-0 items-center transition-colors ${PRIMARY_SIDEBAR_HOVER.row}`,
  /** Clickable button area inside header */
  button: "flex min-w-0 flex-1 items-center gap-1.5 pl-4 pr-2 text-left",
  /** Folder name text */
  name: "min-w-0 truncate text-[12px] font-medium text-text-1",
  /** Branch name text */
  branch: "min-w-0 truncate text-[11px] text-text-3",
  /** Standard folder/worktree row action button. Visibility is controlled by the row's action wrapper. */
  action: HEADER_BUTTON.actionTreeRow,
  /** Folder/worktree row action wrapper — hidden until the parent row is hovered/focused so it does not reserve space. */
  actions:
    "mr-1.5 hidden shrink-0 items-center gap-0.5 group-focus-within/folder-header:flex group-hover/folder-header:flex has-[[data-state=open]]:flex",
} as const;
