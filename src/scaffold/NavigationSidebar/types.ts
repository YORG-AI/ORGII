/**
 * Sidebar Types
 *
 * Centralized type definitions for the unified sidebar system.
 * All sidebar components should use these types for consistency.
 */
import type { LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

// ============================================
// Base Types
// ============================================

/**
 * Sidebar icon representation.
 *
 * - Prefer Lucide icon components (e.g. `Terminal`)
 * - Some configs still use string icon names during migration (e.g. `"Terminal"`)
 */
export type SidebarIcon = LucideIcon | string;

/** Theme configuration for custom-styled sidebars */
export interface SidebarTheme {
  background?: string;
  foreground?: string;
  border?: string;
  accent?: string;
}

// ============================================
// Item Types
// ============================================

/** Base sidebar item */
export interface SidebarItemData {
  id: string;
  name: string;
  icon?: SidebarIcon;
  subtitle?: string;
  shortcut?: string;
  isActive?: boolean;
  disabled?: boolean;
  badge?: string | number;
  metadata?: Record<string, unknown>;
  actions?: ReactNode; // Custom action buttons (e.g., dropdown menu)
}

/** Extended item with actions */
export interface SidebarItemWithActions extends SidebarItemData {
  canClose?: boolean;
  canPin?: boolean;
  isPinned?: boolean;
  onClick?: () => void;
  onClose?: (e: MouseEvent) => void;
  onPin?: () => void;
}

/** Item type for categorized items */
export type SidebarItemType =
  | "session"
  | "terminal"
  | "browser"
  | "file"
  | "document"
  | "repo"
  | "custom";

// ============================================
// Group Types
// ============================================

/** Sidebar group/category */
export interface SidebarGroupData<T extends SidebarItemData = SidebarItemData> {
  id: string;
  title?: string;
  icon?: SidebarIcon;
  items: T[];
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  onAddNew?: () => void;
  addButtonLabel?: string;
}

// ============================================
// Tab Types
// ============================================

/** Tab configuration */
export interface SidebarTab {
  key: string;
  label: string;
  icon?: SidebarIcon;
  iconName?: string;
  disabled?: boolean;
}

/** Tab style */
export type SidebarTabStyle = "pill" | "text" | "underline";

// ============================================
// Action Types
// ============================================

/** Sidebar action button */
export interface SidebarAction {
  id: string;
  icon: SidebarIcon;
  tooltip?: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

// ============================================
// Empty State Types
// ============================================

/** Empty state configuration */
export interface SidebarEmptyStateConfig {
  icon?: SidebarIcon;
  title?: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// ============================================
// Component Props Types
// ============================================

/** SidebarBase props */
export interface SidebarBaseProps {
  /** Children content */
  children: ReactNode | ((width: number) => ReactNode);
  /** Optional header component */
  header?: ReactNode;
  /** Additional class names */
  className?: string;
  /** Inner container class names */
  innerClassName?: string;
  /** Include traffic light spacing (macOS) */
  includeTrafficLightSpace?: boolean;
  /** Show collapse button */
  showCollapseButton?: boolean;
  /** Wrap in the themed sidebar surface */
  wrapInSurface?: boolean;
  /** Paint an opaque themed surface instead of honoring sidebar transparency. */
  solidSurface?: boolean;
  /** Force sidebar to be visible even when collapsed (used for hover sidebar) */
  forceVisible?: boolean;
  /** Custom theme */
  theme?: SidebarTheme;
  /** Collapse callback */
  onCollapse?: () => void;
  /** Add new item callback (shows plus button in traffic lights area) */
  onAddNew?: () => void;
  /** Icon for add button */
  addIcon?: LucideIcon;
  /** Label for add button tooltip */
  addLabel?: string;
  /** Optional rich tooltip content for the add button. */
  addTooltipContent?: ReactNode;
  /** Extra controls rendered before the add button. */
  beforeAddNewActions?: ReactNode;
  /** Extra controls to the right of the add button (e.g. session group-by filter) */
  headerActions?: ReactNode;
}

/** SidebarHeader props */
export interface SidebarHeaderProps {
  /** Title text */
  title?: string;
  /** Title icon */
  icon?: SidebarIcon;
  /** Tab configuration */
  items?: SidebarTab[];
  /** Active tab key */
  activeKey?: string;
  /** Tab change handler */
  onChange?: (key: string) => void;
  /** Tab style */
  tabStyle?: SidebarTabStyle;
  /** Action buttons */
  actions?: SidebarAction[];
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
}

/** SidebarSearch props */
export interface SidebarSearchProps {
  /** Search value */
  value: string;
  /** Change handler */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Action buttons next to search */
  actions?: SidebarAction[];
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
}

/** SidebarGroup props */
export interface SidebarGroupProps<
  T extends SidebarItemData = SidebarItemData,
> {
  /** Group data */
  group: SidebarGroupData<T>;
  /** Whether group is collapsed */
  isCollapsed?: boolean;
  /** Toggle collapse handler */
  onToggle?: () => void;
  /** Item click handler */
  onItemClick?: (item: T) => void;
  /** Item close handler */
  onItemClose?: (item: T, e: MouseEvent) => void;
  /** Custom item renderer */
  renderItem?: (item: T, isActive: boolean) => ReactNode;
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
}

/** SidebarItem props */
export interface SidebarItemProps {
  /** Item data */
  item: SidebarItemData;
  /** Whether item is active */
  isActive?: boolean;
  /** Click handler */
  onClick?: () => void;
  /** Close handler (if closeable) */
  onClose?: (e: MouseEvent) => void;
  /** Pin handler (if pinnable) */
  onPin?: () => void;
  /** Whether item is pinned */
  isPinned?: boolean;
  /** Whether item can be closed */
  canClose?: boolean;
  /** Whether item can be pinned */
  canPin?: boolean;
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
}

/** SidebarEmptyState props */
export interface SidebarEmptyStateProps {
  /** Empty state config */
  config?: SidebarEmptyStateConfig;
  /** Search query (shows "no results" message) */
  searchQuery?: string;
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
}

/** SidebarList props */
export interface SidebarListProps {
  /** Children content */
  children: ReactNode;
  /** Loading state */
  isLoading?: boolean;
  /** Custom theme */
  theme?: SidebarTheme;
  /** Additional class names */
  className?: string;
  /** Preserve top padding for sidebars that still need vertical offset. */
  topPadding?: boolean;
}

/** SidebarSection props */
export interface SidebarSectionProps {
  /** Section title */
  title?: string;
  /** Header variant: "text" (default), "icon" (with icon), or "back" (with back arrow) */
  variant?: "text" | "icon" | "back";
  /** Icon for "icon" variant */
  icon?: SidebarIcon;
  /** Back handler for "back" variant */
  onBack?: () => void;
  /** Children content */
  children: ReactNode;
  /** Additional class names */
  className?: string;
}

// ============================================
// Variant Props Types
// ============================================

/** Tab configuration for session sidebar */
export interface SessionSidebarTab {
  key: string;
  label: string;
}

/** SidebarSession props (for session create/workspace) */
export interface SessionSidebarProps {
  /** Sessions list */
  sessions: SidebarItemWithActions[];
  /** Active session ID */
  activeSessionId?: string;
  /** Session click handler */
  onSessionClick?: (session: SidebarItemWithActions) => void;
  /** Session close handler */
  onSessionClose?: (session: SidebarItemWithActions, e: MouseEvent) => void;
  /** Create session handler */
  onCreateSession?: () => void;
  /** Optional tab configuration */
  tabs?: SessionSidebarTab[];
  /** Active tab key */
  activeTab?: string;
  /** Tab change handler */
  onTabChange?: (key: string) => void;
  /** Loading state */
  isLoading?: boolean;
  /** Custom content renderer for non-default tabs */
  renderTabContent?: (tabKey: string) => ReactNode;
}
