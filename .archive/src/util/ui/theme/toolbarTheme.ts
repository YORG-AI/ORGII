/**
 * Toolbar Theme Resolver
 *
 * Implements Safari's toolbar/tabbar theme switching logic.
 *
 * Key concept: Toolbar and tabbar each make ONE theme decision based on the
 * glass composite appearance (not the raw background). All components inside
 * that region inherit the same theme.
 *
 * Safari's behavior:
 * - Measure the GLASS COMPOSITE (after blur + tint + specular)
 * - If glass looks dark → use light theme (white text/icons)
 * - If glass looks light → use dark theme (dark text/icons)
 * - Use hysteresis to prevent flickering
 *
 * This is NOT about individual text colors - it's about switching the entire
 * theme context for that region.
 */
import { getMaterialConfig } from "@src/components/Glass/config";

import type { GlassMaterial } from "./glassMaterial/types";
import { getRelativeLuminance } from "./luminance";

// ============================================
// Types
// ============================================

/** Toolbar regions that can have independent themes */
export type ToolbarRegion = "toolbar" | "tabbar";

/** Region theme - which theme palette to use */
export type RegionTheme = "light" | "dark";

/** Theme decision for a region */
export interface RegionThemeDecision {
  /** Which theme to apply to all components in this region */
  theme: RegionTheme;
  /** Computed luminance of the glass composite (0-1) */
  glassLuminance: number;
  /** Confidence in this decision (0-1, used for hysteresis) */
  confidence: number;
  /** Whether this decision is stable (past hysteresis threshold) */
  isStable: boolean;
}

/** RGB color */
interface RGB {
  r: number;
  g: number;
  b: number;
}

// ============================================
// Glass Composite Simulation
// ============================================

/**
 * Simulate the final glass composite appearance
 *
 * Safari's decision is based on the RESULT of blur+tint+specular+vibrancy,
 * not the raw background pixels. This function simulates that composite.
 *
 * Steps:
 * 1. Start with background color
 * 2. Apply material base layer (semi-transparent white/gray)
 * 3. Apply tint overlay (very subtle color hint)
 * 4. Apply vibrancy adjustments (brightness/contrast boost)
 * 5. Account for specular highlight (brightens perceived appearance)
 */
function simulateGlassComposite(
  backgroundRGB: RGB,
  glassMaterial: GlassMaterial,
  isDark: boolean,
  thickness: "ultrathin" | "thin" | "medium" | "thick"
): { luminance: number; perceivedBrightness: number } {
  const materialConfig = getMaterialConfig(isDark, thickness);

  // Step 1: Background color (normalized)
  let red = backgroundRGB.r / 255;
  let green = backgroundRGB.g / 255;
  let blue = backgroundRGB.b / 255;

  // Step 2: Blur effect (simulated as 50% blend toward mid-gray)
  // Blur averages colors, pushing extreme values toward middle
  const blurMix = 0.3; // How much blur "muddies" the background
  const midGray = 0.5;
  red = red * (1 - blurMix) + midGray * blurMix;
  green = green * (1 - blurMix) + midGray * blurMix;
  blue = blue * (1 - blurMix) + midGray * blurMix;

  // Step 3: Material base layer (semi-transparent white/gray overlay)
  // Extract RGB from background string like "rgba(255, 255, 255, 0.42)"
  const bgMatch = materialConfig.background.match(
    /rgba?\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/
  );
  if (bgMatch) {
    const baseR = parseInt(bgMatch[1]) / 255;
    const baseG = parseInt(bgMatch[2]) / 255;
    const baseB = parseInt(bgMatch[3]) / 255;
    const alpha = parseFloat(bgMatch[4]);

    // Alpha blend
    red = red * (1 - alpha) + baseR * alpha;
    green = green * (1 - alpha) + baseG * alpha;
    blue = blue * (1 - alpha) + baseB * alpha;
  }

  // Step 4: Tint overlay (very subtle - 1.5-3% opacity)
  const tintAlpha = materialConfig.tintOpacity;
  const tintR = glassMaterial.tintRGB.r / 255;
  const tintG = glassMaterial.tintRGB.g / 255;
  const tintB = glassMaterial.tintRGB.b / 255;

  // Color blend mode simulation (affects hue without changing luminance much)
  // For simplicity, use normal alpha blend at very low opacity
  red = red * (1 - tintAlpha) + tintR * tintAlpha;
  green = green * (1 - tintAlpha) + tintG * tintAlpha;
  blue = blue * (1 - tintAlpha) + tintB * tintAlpha;

  // Step 5: Vibrancy adjustments (brightness + contrast)
  // Apply brightness multiplier
  red *= materialConfig.brightness;
  green *= materialConfig.brightness;
  blue *= materialConfig.brightness;

  // Apply contrast (around midpoint)
  const contrast = materialConfig.contrast;
  const contrastMidpoint = 0.5;
  red = (red - contrastMidpoint) * contrast + contrastMidpoint;
  green = (green - contrastMidpoint) * contrast + contrastMidpoint;
  blue = (blue - contrastMidpoint) * contrast + contrastMidpoint;

  // Step 6: Specular highlight boost (top portion gets brighter)
  // Safari's specular is visible and affects perceived brightness
  const specularBoost = glassMaterial.highlightOpacity * 0.15; // ~15% contribution
  red = Math.min(1, red + specularBoost);
  green = Math.min(1, green + specularBoost);
  blue = Math.min(1, blue + specularBoost);

  // Clamp to valid range
  red = Math.max(0, Math.min(1, red));
  green = Math.max(0, Math.min(1, green));
  blue = Math.max(0, Math.min(1, blue));

  // Convert back to 0-255 for luminance calculation
  const finalR = red * 255;
  const finalG = green * 255;
  const finalB = blue * 255;

  const luminance = getRelativeLuminance(finalR, finalG, finalB);

  // Perceived brightness (simple average, slightly weighted toward luminance)
  const perceivedBrightness =
    luminance * 0.7 + ((red + green + blue) / 3) * 0.3;

  return { luminance, perceivedBrightness };
}

// ============================================
// Theme Resolution
// ============================================

/**
 * Safari's threshold for theme switching
 *
 * Based on WCAG luminance:
 * - L < 0.4: Glass looks dark → use light theme (white text)
 * - L > 0.6: Glass looks light → use dark theme (dark text)
 * - 0.4-0.6: Gray zone (use hysteresis)
 */
const THEME_THRESHOLDS = {
  /** Below this: definitely use light theme (white text on dark glass) */
  darkGlass: 0.4,
  /** Above this: definitely use dark theme (dark text on light glass) */
  lightGlass: 0.6,
  /** Hysteresis buffer: require X% beyond threshold to flip */
  hysteresisBuffer: 0.1, // 10%
  /** Confidence scaling factor */
  confidenceScale: 2.5,
} as const;

/**
 * Resolve theme for a toolbar region
 *
 * @param glassMaterial - Resolved glass material for the region
 * @param backgroundRGB - Average background color behind the region
 * @param isDark - Current app theme mode
 * @param thickness - Material thickness
 * @param previousTheme - Previous theme decision (for hysteresis)
 * @returns Theme decision with confidence and stability
 */
export function resolveRegionTheme(
  glassMaterial: GlassMaterial,
  backgroundRGB: RGB,
  isDark: boolean,
  thickness: "ultrathin" | "thin" | "medium" | "thick" = "thin",
  previousTheme?: RegionTheme
): RegionThemeDecision {
  // Simulate glass composite appearance
  const { luminance, perceivedBrightness } = simulateGlassComposite(
    backgroundRGB,
    glassMaterial,
    isDark,
    thickness
  );

  // Use perceived brightness for theme decision (more stable than pure luminance)
  const metric = perceivedBrightness;

  // Determine theme without hysteresis (ideal choice)
  let idealTheme: RegionTheme;
  let confidence: number;

  if (metric < THEME_THRESHOLDS.darkGlass) {
    // Glass is dark → use light theme (white text)
    idealTheme = "light";
    // Confidence increases as we get darker
    confidence = Math.min(
      1,
      (THEME_THRESHOLDS.darkGlass - metric) * THEME_THRESHOLDS.confidenceScale
    );
  } else if (metric > THEME_THRESHOLDS.lightGlass) {
    // Glass is light → use dark theme (dark text)
    idealTheme = "dark";
    // Confidence increases as we get lighter
    confidence = Math.min(
      1,
      (metric - THEME_THRESHOLDS.lightGlass) * THEME_THRESHOLDS.confidenceScale
    );
  } else {
    // Gray zone - prefer previous theme if available
    idealTheme = previousTheme || "light"; // Default to light if no history
    // Low confidence in gray zone
    confidence = 0.3;
  }

  // Apply hysteresis if we have previous theme
  let finalTheme = idealTheme;
  let isStable = true;

  if (previousTheme && previousTheme !== idealTheme) {
    // We want to flip, but check if we exceed threshold + buffer
    const buffer = THEME_THRESHOLDS.hysteresisBuffer;

    if (idealTheme === "light") {
      // Flipping to light (glass got darker)
      // Require luminance < darkThreshold - buffer
      if (metric > THEME_THRESHOLDS.darkGlass - buffer) {
        // Not dark enough yet, stay with previous
        finalTheme = previousTheme;
        isStable = false;
      }
    } else {
      // Flipping to dark (glass got lighter)
      // Require luminance > lightThreshold + buffer
      if (metric < THEME_THRESHOLDS.lightGlass + buffer) {
        // Not light enough yet, stay with previous
        finalTheme = previousTheme;
        isStable = false;
      }
    }
  }

  return {
    theme: finalTheme,
    glassLuminance: luminance,
    confidence,
    isStable,
  };
}

export default {
  resolveRegionTheme,
};
