/**
 * Shared Spotlight Types
 *
 * Common types used across all spotlight components (Editor, Session, Global)
 */
import React from "react";

// ============ BASE PALETTE PROPS ============

/**
 * Shared props every palette accepts.
 *
 * Palettes are pure content — they render inside a SpotlightShell which
 * owns all visual chrome (panel, portal, width, footer). No asPortal /
 * width / className surface here on purpose: there is only one shell style.
 */
export interface BasePaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onGoBackToParent?: () => void;
}

// ============ SPOTLIGHT ITEM ============

export type StatusType = "ongoing" | "completed" | "failed";

/** Data object attached to SpotlightItem */
export interface SpotlightItemData {
  /** Whether this is an open tab */
  isOpenTab?: boolean;
  /** Parent action ID for child items */
  parentAction?: string;
  /** Whether this item is in selector mode */
  isSelector?: boolean;
  /** Whether this is the currently selected item in selector */
  isCurrentSelection?: boolean;
  /** Whether this is a header item (non-clickable) */
  isHeader?: boolean;
  /** Git status for repos */
  gitStatus?: {
    uncommittedFiles: number;
    ahead: number;
    behind: number;
  };
  /** Right-side label (e.g., branch date, file path) */
  rightLabel?: string;
  /** Right-side React content (e.g., provider icons with count) — takes precedence over rightLabel */
  rightContent?: React.ReactNode;
  /** Tag label to display at the right end */
  tagLabel?: string;
  /** Shows a reusable right-edge indicator for rows that open another layer or navigate. */
  showDisclosureChevron?: boolean;
  /** Indicator icon variant: chevron for nested layers, arrowRight for navigation. */
  disclosureIcon?: "chevron" | "arrowRight";
  /** Inline tag rendered right after the label text */
  inlineTag?: string;
  /** Prefix text for hint items */
  prefix?: string;
  /** Whether this item is disabled (visible but not clickable) */
  disabled?: boolean;
  /** Whether this item should use danger styling */
  isDanger?: boolean;
  /** Values exposed through the row's native copy context menu. */
  contextMenuCopy?: {
    name?: string;
    path?: string;
  };
  /** When set, the row renders a Checkbox at the very start (before the
   *  icon) reflecting the given checked state. Used by manage-mode multi
   *  select. The checkbox calls `onToggle`; clicking the rest of the row
   *  is the responsibility of the item's own `action`. */
  selectionState?: {
    checked: boolean;
    onToggle: (e?: React.MouseEvent) => void;
  };
  /** Allow any additional properties */
  [key: string]: unknown;
}

export interface SpotlightItem {
  id: string;
  label: string;
  desc?: string;
  description?: string;
  icon?: string | React.ComponentType<Record<string, unknown>>;
  data?: SpotlightItemData;
  statusType?: StatusType;
  /** Item type for categorization */
  type?:
    | "repo"
    | "branch"
    | "action"
    | "page"
    | "option"
    | "tab"
    | "file"
    | "command"
    | "hint";
  /** Click handler */
  action?: () => void;
  /** Keyboard shortcut hint */
  shortcut?: string;
}
