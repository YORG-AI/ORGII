/**
 * Section Layout Tokens
 *
 * Shared constants and classes for consistent section-based UI layouts.
 * Used across settings, documentation, integrations, and other structured pages.
 */
import type { CSSProperties } from "react";

// ============================================
// Sizing Constants
// ============================================

/** Default width for controls (selects, dropdowns, number inputs, etc.) */
export const SECTION_CONTROL_WIDTH = 280;

/**
 * Container-query breakpoint for stacked → horizontal layout.
 * Used as @[480px]: in Row and Table.
 * Below this width: stacked (label above, controls below).
 * Above this width: horizontal (label left, controls right).
 */
export const SECTION_LAYOUT_BREAKPOINT = 480;

// ============================================
// Control Tokens
// ============================================

/**
 * Inline style for controls.
 * - Targets 280px (definite width so the parent can size correctly)
 * - maxWidth: 100% prevents overflow when the parent is narrower
 */
export const SECTION_CONTROL_STYLE: CSSProperties = {
  width: SECTION_CONTROL_WIDTH,
  maxWidth: "100%",
};

/**
 * Right column in SectionRow (horizontal layout): aligns controls to the trailing edge
 * and caps width at SECTION_CONTROL_WIDTH (via min(100%, …) inside the container).
 */
export const SECTION_ROW_CONTROL_CELL_CLASSES = `flex w-full min-w-0 items-stretch @[480px]:shrink-0 @[480px]:justify-end @[480px]:[width:min(100%,${SECTION_CONTROL_WIDTH}px)]`;

// ============================================
// Section-Level Tokens
// ============================================

/** Page-level heading typography (h2 used in SectionHeading) */
export const SECTION_HEADING_CLASSES =
  "pl-1 text-[18px] font-semibold text-primary-6";

/** Sub-section title typography (used in SectionContainer title) */
export const SECTION_SUBHEADING_CLASSES =
  "pl-1 text-[14px] font-semibold leading-[22px] text-text-1";

/** Wrapper gap between a section heading and its content containers */
export const SECTION_GAP_CLASSES = "flex flex-col gap-3";

// ============================================
// Container Tokens
// ============================================

/** Base classes for the section container (rounded, container-query root, inset row separators) */
export const SECTION_CONTAINER_BASE_CLASSES =
  "w-full rounded-xl @container [&>.section-layout-row:not(:last-child)]:after:absolute [&>.section-layout-row:not(:last-child)]:after:bottom-0 [&>.section-layout-row:not(:last-child)]:after:inset-x-0 [&>.section-layout-row:not(:last-child)]:after:h-px [&>.section-layout-row:not(:last-child)]:after:bg-border-1 [&>.section-layout-row:not(:last-child)]:after:content-['']";

export const SECTION_CONTAINER_CLASSES = `${SECTION_CONTAINER_BASE_CLASSES} border border-border-1 bg-primary-container`;

/** Padding variants for the section container */
export const SECTION_PADDING = {
  /** Horizontal only — use when wrapping Row components (they have their own py) */
  none: "px-4",
  /** Compact vertical padding */
  compact: "px-4 py-2",
  /** Standard vertical padding */
  default: "px-4 py-2",
} as const;

// ============================================
// Row Tokens
// ============================================

/** Default label typography */
export const SECTION_LABEL_CLASSES =
  "text-[14px] font-normal leading-[22px] text-text-1";

/** Light label typography (normal weight) */
export const SECTION_LABEL_LIGHT_CLASSES =
  "text-[14px] font-normal leading-[22px] text-text-1";

/** Description text below labels */
export const SECTION_DESCRIPTION_CLASSES = "mt-0.5 text-[12px] text-text-2";

/** Compact label typography (matches InfoRow density) */
export const SECTION_LABEL_COMPACT_CLASSES =
  "text-[12px] font-normal leading-[18px] text-text-1";

/** Compact description (smaller gap) */
export const SECTION_DESCRIPTION_COMPACT_CLASSES = "text-[11px] text-text-3";

/** Right-side value text in SectionRow content (matches worktree route style). */
export const SECTION_VALUE_TEXT_CLASSES = "text-[14px] text-text-1";

/** Value text with success color (e.g. quota "X% left" when healthy). */
export const SECTION_VALUE_TEXT_SUCCESS_CLASSES = "text-[14px] text-success-6";

/** Value text with warning color (e.g. quota when <30% left). */
export const SECTION_VALUE_TEXT_WARNING_CLASSES = "text-[14px] text-warning-6";

/** Value text with danger color (e.g. quota when <10% left). */
export const SECTION_VALUE_TEXT_DANGER_CLASSES = "text-[14px] text-danger-6";

/**
 * Get semantic value text class based on remaining percentage.
 * <10% = danger, <30% = warning, else = success.
 */
export function getSectionValueTextSemanticClass(
  remainingPercent: number
): string {
  if (remainingPercent < 10) return SECTION_VALUE_TEXT_DANGER_CLASSES;
  if (remainingPercent < 30) return SECTION_VALUE_TEXT_WARNING_CLASSES;
  return SECTION_VALUE_TEXT_SUCCESS_CLASSES;
}

/**
 * Path text in SectionRow (truncates with ellipsis when long).
 * Use for file/directory paths. flex-1 + min-w-0 allows shrink and truncation.
 */
export const SECTION_PATH_TEXT_CLASSES =
  "min-w-0 flex-1 truncate text-[12px] text-text-1";

/** Small value text (e.g. counts like "2 repos"). */
export const SECTION_VALUE_SMALL_CLASSES = "text-[12px] text-text-1";

/** Small secondary value text. */
export const SECTION_VALUE_SMALL_SECONDARY_CLASSES = "text-[12px] text-text-2";

/** Small muted value text. */
export const SECTION_VALUE_SMALL_MUTED_CLASSES = "text-[12px] text-text-3";

/**
 * Indentation for sub-settings.
 *
 * There is ONE indent level (pl-6), applied through SectionRow:
 *
 * 1. Standard indented rows:
 *      <SectionRow label="GPU Layers" indent>
 *        <Select ... />
 *      </SectionRow>
 *
 * 2. Content-only indented blocks:
 *      <SectionRow label="" indent showHeader={false}>
 *        <MyCustomContent />
 *      </SectionRow>
 *
 * Do NOT hardcode pl-6/pl-8/pl-4.
 */
export const SECTION_INDENT_CLASSES = "pl-6";

// ============================================
// Table Tokens
// ============================================

/** Table column header typography */
export const SECTION_TABLE_HEADER_CLASSES =
  "text-[12px] font-medium text-text-2";

/** Table row label typography */
export const SECTION_TABLE_LABEL_CLASSES = "text-[13px] text-text-2";

/** Empty/null cell placeholder */
export const SECTION_TABLE_EMPTY_CLASSES = "text-[12px] text-text-3";

/** Default column grid template (flexible up to control width) */
export const SECTION_TABLE_DEFAULT_COL = `minmax(140px, ${SECTION_CONTROL_WIDTH}px)`;

// ============================================
// Action / Button Group Tokens
// ============================================

/** Gap between action buttons in a SectionRow's right-side slot. min-w-0 for path truncation. */
export const SECTION_ACTION_GAP_CLASSES = "flex min-w-0 items-center gap-2";
