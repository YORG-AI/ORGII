import type { ReactNode } from "react";

import type { ControlAppearance } from "@src/components/controlAppearance";

export interface TabPillItem {
  key: string;
  label: string;
  icon?: ReactNode;
  hoverIcon?: ReactNode;
  badge?: ReactNode;
  /** Trailing content revealed on hover while preserving the tab's width. */
  hoverBadge?: ReactNode;
  disabled?: boolean;
  dropdown?: ReactNode;
  dataTestId?: string;
}

export type TabPillAppearance = ControlAppearance | "muted" | "layout";

export interface TabPillProps {
  tabs: (TabPillItem | string)[];
  activeTab?: string;
  defaultActiveTab?: string;
  onChange?: (key: string) => void;
  activeTabs?: string[];
  onMultiChange?: (keys: string[]) => void;
  variant?: "sidebar" | "pill" | "simple";
  color?: "default" | "fill";
  className?: string;
  iconOnly?: boolean;
  fillWidth?: boolean;
  wrap?: boolean;
  size?: "mini" | "small" | "default" | "large" | "chatPanel";
  /**
   * - `default` / `muted` / `layout` — opaque pill backgrounds tuned for sidebars and filter chips.
   * - `ghost` — transparent inactive and the shared `surface-hover` treatment on hover/active.
   *   Mirrors the Select `appearance="ghost" size="mini"` trigger so a `<TabPill size="mini" appearance="ghost" />`
   *   visually matches the SettingsTable filter selects.
   */
  appearance?: TabPillAppearance;
  /** Button-like grouped switch style with an outlined container and fill-2 active pill. */
  buttonStyle?: boolean;
  /** Explicit outer control height in pixels for compact toolbar placement. */
  height?: number;
  onDropdownRef?: (close: () => void) => void;
}
