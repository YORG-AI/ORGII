/**
 * Sidebar Configuration
 *
 * Centralized configuration for sidebar styling and behavior.
 */
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";

// ============================================
// Style Configuration
// ============================================

export const SIDEBAR_STYLE = {
  /** Traffic lights reserved space */
  trafficLightsPadding: 80,
  /** Top bar height */
  topBarHeight: WINDOW_CHROME_TOKENS.titleBarHeight,
  /** Search input height */
  searchHeight: 28,
  /** Action button size */
  actionButtonSize: 28,
  /** Shared navigation row height */
  rowHeight: 32,
  /** Border radius */
  borderRadius: 20,
  /** Item border radius */
  itemBorderRadius: 6,
} as const;

// ============================================
// Padding Configuration
// ============================================

export const SIDEBAR_PADDING = {
  /** Horizontal padding for section content (px) - px-2 = 8px */
  sectionX: 8,
  /** Top padding for section content (px) - pt-4 = 16px */
  sectionTop: 16,
  /** Gap between sections (px) */
  sectionGap: 8,
  /** Internal item padding (px) */
  itemX: 8,
  /** Section header height (px) */
  sectionHeaderHeight: 28,
} as const;
