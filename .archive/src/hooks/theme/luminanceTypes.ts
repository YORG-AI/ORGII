/**
 * Shared luminance types for region-based background sampling.
 *
 * Lives as a leaf module so both the hook (`useRegionLuminance`) and the
 * pure sampling utilities (`luminanceSampling`) can depend on it without
 * forming an import cycle.
 */

export type LuminanceRegion =
  | "sidebar"
  | "toolbar"
  | "tabbar"
  | "content"
  | "global";

export interface RegionLuminanceData {
  /** Luminance value 0-1 (0 = black, 1 = white) */
  luminance: number;
  /** Whether the region is light (luminance > 0.5) */
  isLight: boolean;
  /** Recommended text color for contrast (primary text) */
  textColor: string;
  /** Theme text colors based on background luminance */
  text: {
    text1: string;
    text2: string;
    text3: string;
    text4: string;
  };
}

export interface RegionLuminanceMap {
  sidebar: RegionLuminanceData;
  toolbar: RegionLuminanceData;
  tabbar: RegionLuminanceData;
  content: RegionLuminanceData;
  global: RegionLuminanceData;
}
