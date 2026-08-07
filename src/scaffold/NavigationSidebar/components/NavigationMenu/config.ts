// ============================================
// NavigationMenu Configuration
// ============================================
import type { LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import type { TabDragPillPayload } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

export interface NavigationMenuRowAction {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  /** Stable rendered selector for high-value header/row actions. */
  dataTestId?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export type NavigationMenuIconAction = NavigationMenuRowAction;

/**
 * Navigation menu item configuration
 * Defines structure for menu items used in sidebar navigation
 *
 * Tab Types:
 * - mainApp: app, terminal, browser
 * - code: editor
 */
export interface NavigationMenuItem {
  id: string;
  key: string;
  label: string;
  /** Optional hidden text used by sidebar search/filtering. */
  searchText?: string;
  /** Optional secondary line rendered below the label (e.g. branch name). */
  subtitle?: ReactNode;
  icon?: LucideIcon | string;
  iconName?: string;
  /** Arbitrary rendered icon — takes precedence over `icon` when set. */
  iconElement?: ReactNode;
  /** Optional hover/focus action that replaces the leading icon in-place. */
  iconAction?: NavigationMenuIconAction;
  /** Optional element rendered at the far right edge of the row. */
  trailingElement?: ReactNode;
  /**
   * Status indicator (e.g. "working" breathing dot) rendered at the trailing
   * edge but BEFORE the grid-stacked content, and NOT faded out on hover.
   * Use when a state must remain visible while hover-only content
   * (timestamps, action buttons) is shown.
   */
  workingIndicator?: ReactNode;
  /** Shows a chevron to indicate the row opens a deeper sidebar level. */
  showDrillDownIndicator?: boolean;
  /** Indents the row and draws a vertical guide line for inline child rows. */
  showIndentGuide?: boolean;
  visualTone?: "default" | "secondary";
  /** Show hover-only row action buttons. */
  showMoreActions?: boolean;
  rowActions?: NavigationMenuRowAction[];
  rowActionIcon?: LucideIcon;
  rowActionLabel?: string;
  onRowActionClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Let a primary click on the selected row open its context menu. */
  openContextMenuOnSelectedClick?: boolean;
  routePath?: string;
  /** Tab type for proper tab handling */
  tabType?: "app" | "terminal" | "browser" | "editor";
  children?: NavigationMenuItem[];
  shortcut?: string;
  disabled?: boolean;
  dataTestId?: string;
  /**
   * When set, the row becomes draggable. Dropping it onto a chat input or
   * session creator inserts a context pill using the existing tab-drag-end
   * event system.
   */
  dragPayload?: TabDragPillPayload;
}
