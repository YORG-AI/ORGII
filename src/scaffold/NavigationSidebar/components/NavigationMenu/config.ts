// ============================================
// NavigationMenu Configuration
// ============================================
import type { MouseEvent, ReactNode } from "react";

import type { AnyIconSource } from "@src/components/AnyIcon";
import type { IconSvgElement } from "@src/icons";
import type { TabDragPillPayload } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

export interface NavigationMenuRowAction {
  icon?: IconSvgElement;
  /** Stable `data-icon` hook stamped on the rendered glyph (tests/debugging). */
  dataIcon?: string;
  /** Optional class applied to the rendered icon (for example refresh spin). */
  iconClassName?: string;
  label: string;
  active?: boolean;
  /** Stable rendered selector for high-value header/row actions. */
  dataTestId?: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

type NavigationMenuIconAction = NavigationMenuRowAction;

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
  /** Glyph data or a brand component (`""` = no icon) — rendered via `AnyIcon`. */
  icon?: AnyIconSource;
  iconName?: string;
  /** Arbitrary rendered icon — takes precedence over `icon` when set. */
  iconElement?: ReactNode;
  /** Small status badge overlaid on the leading icon, including when collapsed. */
  iconBadge?: ReactNode;
  /** Optional hover/focus action that replaces the leading icon in-place. */
  iconAction?: NavigationMenuIconAction;
  /**
   * Small element pinned to the label's trailing edge — it tracks the text,
   * not the row. Use for a counter that reads as part of the label (an unread
   * count); `trailingElement` right-aligns to the row edge instead.
   */
  labelBadge?: ReactNode;
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
  /**
   * The viewer pinned this row. Set by the row builders (local and cloud) so
   * grouping can lift pinned rows without inferring membership from which
   * separator happens to precede them.
   */
  pinned?: boolean;
  /** Show hover-only row action buttons. */
  showMoreActions?: boolean;
  rowActions?: NavigationMenuRowAction[];
  rowActionIcon?: IconSvgElement;
  rowActionLabel?: string;
  onRowActionClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Let a primary click on the selected row open its context menu. */
  openContextMenuOnSelectedClick?: boolean;
  /** This row opens a chat-panel tab and supports explicit new-tab navigation. */
  opensChatPanelTab?: boolean;
  routePath?: string;
  /** Tab type for proper tab handling */
  tabType?: "app" | "terminal" | "browser" | "editor";
  children?: NavigationMenuItem[];
  /**
   * For a row that has `children` (renders as an expandable parent): the row
   * is ITSELF a navigable target, not just a group header. A body/label click
   * selects the item (like a leaf); only the dedicated chevron toggles the
   * submenu. Cloud fork-thread roots set this so the source session stays
   * openable after a fork adds child rows. Default (group headers such as the
   * Work Items list) keeps body-click = toggle.
   */
  navigableParent?: boolean;
  /** Keep a parent row's disclosure control beside its label instead of right-aligning it. */
  disclosureFollowsLabel?: boolean;
  shortcut?: string;
  disabled?: boolean;
  dataTestId?: string;
  /** Stable target consumed by an in-product guided tour. */
  tourTarget?: string;
  /**
   * When set, the row becomes draggable. Dropping it onto a chat input or
   * session creator inserts a context pill using the existing tab-drag-end
   * event system.
   */
  dragPayload?: TabDragPillPayload;
}
