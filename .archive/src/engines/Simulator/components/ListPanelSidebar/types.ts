import type { ReactNode } from "react";

/**
 * ListPanelSidebar Types
 *
 * Reusable left panel sidebar with Tab | Filter | List structure.
 * Used by git status page, file operations IDE, etc.
 *
 * ListPanelContent: Tab-free content component (filter + list body).
 * Can be used standalone inside other containers like PrimarySidebarLayoutWithSections.
 */

export interface TabConfig<T extends string = string> {
  key: T;
  label: string;
}

export interface ListPanelItem {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Optional secondary text (e.g. directory path) */
  secondaryText?: string;
  /** Whether this item is the "current" one (shows indicator) */
  isCurrent?: boolean;
  /** File name for icon detection (used if icon not provided) */
  fileName?: string;
  /** Custom icon element (overrides fileName-based icon) */
  icon?: ReactNode;
  /** Whether this item is checked (for checkbox mode) */
  checked?: boolean;
  /** Optional status badge text (e.g. "M", "U", "D" for git - VSCode convention) */
  statusBadge?: string;
  /** Optional status badge color class */
  statusBadgeClass?: string;
  /** Optional predefined status type (auto-generates badge + color) */
  status?: "modified" | "added" | "deleted" | "renamed" | "untracked";
  /** Whether this item is agent-selected (shows blue dot) */
  isAgentSelected?: boolean;
}

// ============================================
// ListPanelContent Props (tab-free body)
// ============================================

export interface ListPanelContentProps {
  /** Search/filter query */
  filterQuery: string;
  /** Filter change callback */
  onFilterChange: (query: string) => void;
  /** Filter placeholder text */
  filterPlaceholder?: string;

  /** List items */
  items: ListPanelItem[];
  /** Selected item ID */
  selectedId: string | null;
  /** Item select callback */
  onSelectItem: (id: string) => void;

  /** Optional: render custom item content */
  renderItem?: (item: ListPanelItem, isSelected: boolean) => ReactNode;

  /** Loading state */
  loading?: boolean;
  /** Empty state message */
  emptyMessage?: string;
  /** No results message */
  noResultsMessage?: string;

  // ============================================
  // Checkbox Options
  // ============================================

  /** Show checkboxes on items */
  showCheckbox?: boolean;
  /** Callback when item checkbox changes */
  onItemCheckChange?: (id: string, checked: boolean) => void;
  /** Show select all checkbox in header */
  showSelectAll?: boolean;
  /** Callback when select all changes */
  onSelectAllChange?: (checked: boolean) => void;
  /** Label for item count (e.g. "file", "item") */
  itemLabel?: string;

  // ============================================
  // Status Badge (Optional)
  // ============================================

  /** Show status badges (M/U/D/R) on items - defaults to true if items have status */
  showStatusBadge?: boolean;

  // ============================================
  // Agent Selection Indicator (Optional)
  // ============================================

  /** Show agent selection indicator (blue dot) - defaults to true */
  showAgentIndicator?: boolean;

  // ============================================
  // Footer (Optional)
  // ============================================

  /** Optional footer content (e.g. commit section) */
  footer?: ReactNode;
  /** Whether to show footer - defaults to true if footer is provided */
  showFooter?: boolean;
}

// ============================================
// ListPanelSidebar Props (with tabs)
// ============================================

export interface ListPanelSidebarProps<
  TTab extends string = string,
> extends ListPanelContentProps {
  /** Tab configuration */
  tabs: TabConfig<TTab>[];
  /** Active tab key */
  activeTab: TTab;
  /** Tab change callback */
  onTabChange: (tab: TTab) => void;

  /** Optional width class (ignored if width is provided) */
  widthClass?: string;

  /** Optional fixed width in pixels (overrides widthClass) */
  width?: number;

  /** Whether tabs should fill available width (default: true) */
  tabsFillWidth?: boolean;
}
