import type { ReactNode } from "react";

import type { ControlAppearance } from "@src/components/controlAppearance";

export interface TabPillItem {
  key: string;
  label: string;
  icon?: ReactNode;
  hoverIcon?: ReactNode;
  /** Keep this tab's label visible when its siblings collapse to icons. */
  alwaysShowLabel?: boolean;
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
  variant?: "sidebar" | "pill" | "simple";
  color?: "default" | "fill";
  className?: string;
  iconOnly?: boolean;
  /**
   * Keeps the selected tab readable while compacting the remaining tabs to
   * their icons. Tabs still expose their labels through accessible names and
   * native tooltips.
   */
  inactiveIconOnly?: boolean;
  /** Text treatment for the selected pill. */
  activeTone?: "primary" | "neutral";
  /** Show the active-state dot used by the compact `simple` variant. */
  showActiveIndicator?: boolean;
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
}
