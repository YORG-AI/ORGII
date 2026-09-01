/**
 * Background Page Types
 */

export type { BackgroundColorPreset } from "@src/config/appearance/backgroundColors";

export interface ImagePreset {
  label: string;
  value: string;
  thumbnail: string;
}

type GlassLevel = "regular" | "medium" | "thick";

export interface BackgroundConfig {
  backgroundColor?: string;
  /** ID of the active color preset (e.g. "classic"). */
  backgroundColorId?: string;
  imageUrl?: string;
  selectedImageId?: string;
  customImages?: string[];
  /** DIY solid hex colors persisted with background config */
  customColors?: string[];
  blurAmount?: number;
  /**
   * When set, the background renders as a Glass overlay at the
   * given thickness instead of using `imageUrl` / `backgroundColor`.
   * Mutually exclusive with the image / solid-color paths.
   */
  glass?: GlassLevel;
  /**
   * When true, toolbar text and pill colors adapt to the brightness of the
   * background behind them. Defaults to true when undefined.
   */
  adaptiveColors?: boolean;
  /**
   * Page panel opacity as an integer percent. Range is clamped to
   * [MIN_PAGE_OPACITY, 100]. Undefined or 100 = fully opaque.
   */
  pageOpacity?: number;
  /**
   * Sidebar surface opacity as an integer percent. Range is clamped to
   * 0–100. Undefined or 100 = fully opaque.
   */
  sidebarOpacity?: number;
}

export interface BackgroundSettingsProps {
  /** Whether to show the back button and header */
  showHeader?: boolean;
  /**
   * When true, renders as inline section content (parent provides scroll).
   * Use inside Appearance settings; omit outer full-height shell and ScrollFadeContainer.
   */
  embedded?: boolean;
  /** Optional custom translation namespace (defaults to "settings") */
  translationNamespace?: string;
}

/** Dropdown values for Background settings — colors vs images surface */
export const BACKGROUND_CONTENT_SOURCE = {
  COLORS: "colors",
  IMAGES: "images",
} as const;
export type BackgroundContentSource =
  (typeof BACKGROUND_CONTENT_SOURCE)[keyof typeof BACKGROUND_CONTENT_SOURCE];

export interface StorageInfo {
  path: string;
  used: number;
  limit: number;
}
