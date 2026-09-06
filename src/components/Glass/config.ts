// ============================================
// Glass Material Configuration
// Based on Apple's macOS material design system
// ============================================

/**
 * Material thickness variations
 * Based on Apple's NSVisualEffectView material types
 */
export type MaterialThickness = "ultrathin" | "thin" | "medium" | "thick";

/**
 * Complete material configuration for light and dark themes
 * Single source of truth for all glass material properties
 */
export interface MaterialConfig {
  /** Background color with alpha transparency */
  background: string;
  /** Backdrop blur intensity in pixels */
  blur: number;
  /** Backdrop saturation multiplier (1.0 = 100%, Safari uses neutral) */
  saturation: number;
  /** Backdrop brightness multiplier (Safari uses 1.12 = 112%) */
  brightness: number;
  /** Backdrop contrast multiplier (Safari uses 1.05 = 105%) */
  contrast: number;
  /** Tint opacity for the surface color hint (0.015-0.03) */
  tintOpacity: number;
}

/**
 * Light theme material configurations
 * Based on Apple's macOS design system
 *
 * Safari: Bright base + minimal blur + neutral saturation + vibrancy from brightness/contrast
 */
export const LIGHT_MATERIALS: Record<MaterialThickness, MaterialConfig> = {
  ultrathin: {
    background: "rgba(255, 255, 255, 0.55)",
    blur: 6,
    saturation: 1.0, // 100% - neutral
    brightness: 1.12, // 112% - Safari brightness boost
    contrast: 1.05, // 105% - crispness
    tintOpacity: 0.008, // 0.8% - reinforcement layer (main tint is in base blend)
  },
  thin: {
    background: "rgba(255, 255, 255, 0.62)",
    blur: 8,
    saturation: 1.0,
    brightness: 1.12,
    contrast: 1.05,
    tintOpacity: 0.01, // 1% - reinforcement layer
  },
  medium: {
    background: "rgba(255, 255, 255, 0.70)",
    blur: 10,
    saturation: 1.0,
    brightness: 1.12,
    contrast: 1.05,
    tintOpacity: 0.012, // 1.2% - reinforcement layer
  },
  thick: {
    background: "rgba(255, 255, 255, 0.78)",
    blur: 12,
    saturation: 1.0,
    brightness: 1.12,
    contrast: 1.05,
    tintOpacity: 0.015, // 1.5% - reinforcement layer
  },
};

/**
 * Dark theme material configurations
 * Based on Apple's macOS design system
 *
 * Safari: Lighter grays + same vibrancy settings as light mode
 */
export const DARK_MATERIALS: Record<MaterialThickness, MaterialConfig> = {
  ultrathin: {
    background: "rgba(30, 30, 32, 0.65)",
    blur: 6,
    saturation: 1.0, // 100% - neutral
    brightness: 1.0, // No brightness boost in dark mode
    contrast: 1.02, // Subtle contrast
    tintOpacity: 0.006, // 0.6% - reinforcement layer (main tint is in base blend)
  },
  thin: {
    background: "rgba(28, 28, 30, 0.72)",
    blur: 8,
    saturation: 1.0,
    brightness: 1.0,
    contrast: 1.02,
    tintOpacity: 0.008, // 0.8% - reinforcement layer
  },
  medium: {
    background: "rgba(26, 26, 28, 0.78)",
    blur: 10,
    saturation: 1.0,
    brightness: 1.0,
    contrast: 1.02,
    tintOpacity: 0.01, // 1% - reinforcement layer
  },
  thick: {
    background: "rgba(24, 24, 26, 0.85)",
    blur: 12,
    saturation: 1.0,
    brightness: 1.0,
    contrast: 1.02,
    tintOpacity: 0.012, // 1.2% - reinforcement layer
  },
};

/**
 * Default material thickness for different use cases
 */
export const DEFAULT_MATERIAL: MaterialThickness = "thin";

/**
 * Get material configuration based on theme and thickness
 */
export const getMaterialConfig = (
  isDark: boolean,
  thickness: MaterialThickness = DEFAULT_MATERIAL
): MaterialConfig => {
  return isDark ? DARK_MATERIALS[thickness] : LIGHT_MATERIALS[thickness];
};

/**
 * Material-based shadow classes
 * Shadows scale proportionally with material thickness
 */
export const getShadowClass = (
  isDark: boolean,
  thickness: MaterialThickness
): string => {
  const prefix = isDark ? "shadow-dark" : "shadow-light";
  return `${prefix}-${thickness}`;
};

/**
 * Material usage guidelines
 * Material thickness controls both opacity and blur intensity
 * Blur scales incrementally: 8px → 12px → 16px → 20px
 */
/**
 * Material usage guidelines
 * - Tint is blended INTO the base material (10% light, 6% dark)
 * - Additional tint reinforcement layer at ~1% opacity
 * - DYNAMIC OPACITY: Opacity scales with background luminance:
 *   - Dark theme: 72% (dark bg) to 88% (bright bg) - always visible
 *   - Light theme: 60% (bright bg) to 82% (dark bg)
 */
export const MATERIAL_USAGE = {
  ultrathin: "Secondary panels, overlays - dynamic opacity (6px blur)",
  thin: "Main content containers, cards - dynamic opacity (8px blur, default)",
  medium: "Sidebars, prominent panels, toolbars - dynamic opacity (10px blur)",
  thick: "High emphasis elements, headers - dynamic opacity (12px blur)",
} as const;
