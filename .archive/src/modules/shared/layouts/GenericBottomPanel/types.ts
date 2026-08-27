import type { ReactNode } from "react";

/**
 * GenericBottomPanel Types
 *
 * Shared types for the reusable bottom panel component.
 * Used by: Settings, WorkStation (future migration), and any module needing
 * a resizable bottom panel with tabs.
 */

export interface BottomPanelTabAction {
  key: string;
  icon: ReactNode;
  tooltip: string;
  onClick: () => void;
  danger?: boolean;
  active?: boolean;
}

export interface BottomPanelTabConfig {
  key: string;
  label: string;
  content: ReactNode;
  actions?: BottomPanelTabAction[];
  badge?: ReactNode;
  /** Extra content rendered in the header between tab actions and maximize/close buttons */
  headerExtra?: ReactNode;
}

export interface GenericBottomPanelProps {
  tabs: BottomPanelTabConfig[];
  activeTab: string;
  onTabChange: (tab: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  height: number;
  onHeightChange: (height: number) => void;
  isMaximized?: boolean;
  onToggleMaximize?: () => void;
  className?: string;
}
