/**
 * Material Resolver
 *
 * Resolves glass material properties from solid surface colors.
 * Includes legibility guard, tint resolution, and specular highlights.
 */
import { getMaterialConfig } from "@src/components/Glass/config";

import type {
  AppearanceMode,
  GlassMaterial,
  LegibilityGuard,
  SurfaceColorField,
} from "./types";

// ============================================
// Constants
// ============================================

/**
 * Specular highlight opacity by material thickness
 * Only property not in the main material config (visual effect, not glass property)
 */
const SPECULAR_HIGHLIGHT_OPACITY = {
  ultrathin: 0.35,
  thin: 0.3,
  medium: 0.22,
  thick: 0.18,
} as const;

/**
 * Appearance-based highlight adjustment
 *
 * Light mode: stronger highlight (multiply by 1.0)
 * Dark mode: subtler highlight (multiply by 0.5)
 */
const APPEARANCE_HIGHLIGHT_MULTIPLIER = {
  light: 1.0,
  dark: 0.5,
} as const;

// ============================================
// Legibility Guard
// ============================================

/**
 * Compute Legibility Guard from background luminance
 *
 * Safari's approach for keeping text readable on any background:
 * - On dark backgrounds: minimal intervention
 * - On bright backgrounds: adds a dark scrim + boosts tint + increases text opacity
 *
 * Formula: scrimStrength = clamp((L - 0.65) / 0.35, 0, 1)
 */
export function computeLegibilityGuard(luminance: number): LegibilityGuard {
  const clampedLuminance = Math.max(0, Math.min(1, luminance));

  const scrimStrength = Math.max(
    0,
    Math.min(1, (clampedLuminance - 0.65) / 0.35)
  );

  const scrimAlpha = scrimStrength * 0.1;
  const tintAlphaBoost = scrimStrength * 0.06;
  const foregroundOpacity = 0.85 + scrimStrength * 0.15;

  return {
    backgroundLuminance: clampedLuminance,
    scrimStrength,
    scrimAlpha,
    tintAlphaBoost,
    foregroundOpacity,
    isActive: scrimStrength > 0,
  };
}

// ============================================
// Tint Resolution
// ============================================

/**
 * Resolve tint color from color field (Safari-style)
 *
 * - Tint opacity from material config (single source of truth)
 * - Hue stays stable (derived from midtones)
 * - Use Display-P3 color space for wide gamut
 */
export function resolveTint(
  colorField: SurfaceColorField,
  appearance: AppearanceMode,
  thickness: "ultrathin" | "thin" | "medium" | "thick"
): {
  tint: string;
  tintP3: string;
  tintRGB: { r: number; g: number; b: number };
} {
  const { dominantRGB } = colorField;

  const materialConfig = getMaterialConfig(appearance === "dark", thickness);
  const opacity = materialConfig.tintOpacity;

  const r01 = dominantRGB.r / 255;
  const g01 = dominantRGB.g / 255;
  const b01 = dominantRGB.b / 255;

  const tint = `rgba(${dominantRGB.r}, ${dominantRGB.g}, ${dominantRGB.b}, ${opacity})`;
  const tintP3 = `color(display-p3 ${r01.toFixed(3)} ${g01.toFixed(3)} ${b01.toFixed(3)} / ${opacity.toFixed(3)})`;

  return {
    tint,
    tintP3,
    tintRGB: dominantRGB,
  };
}

// ============================================
// Material Resolution
// ============================================

/**
 * Resolve complete glass material from color field (Safari-style)
 *
 * Gets all base properties from material config (single source of truth).
 * Only derives: tint color, rim offsets, and the legibility guard.
 */
export function resolveMaterial(
  colorField: SurfaceColorField,
  appearance: AppearanceMode,
  thickness: "ultrathin" | "thin" | "medium" | "thick"
): GlassMaterial {
  const materialConfig = getMaterialConfig(appearance === "dark", thickness);
  const { tint, tintP3, tintRGB } = resolveTint(
    colorField,
    appearance,
    thickness
  );

  const legibilityGuard = computeLegibilityGuard(colorField.luminance);

  let highlightOpacity =
    SPECULAR_HIGHLIGHT_OPACITY[thickness] *
    APPEARANCE_HIGHLIGHT_MULTIPLIER[appearance];

  if (legibilityGuard.isActive) {
    highlightOpacity *= 1 - legibilityGuard.scrimStrength * 0.5;
  }

  const shadowOpacity = appearance === "dark" ? 0.3 : 0.1;

  const baseRimBoost = colorField.luminance < 0.4 ? 40 : 25;
  const rimReduction = legibilityGuard.isActive
    ? legibilityGuard.scrimStrength * 15
    : 0;
  const rimOffsets = {
    base: baseRimBoost - rimReduction,
    highlight: baseRimBoost + 15 - rimReduction,
    glow: baseRimBoost - 5 - rimReduction,
  };

  return {
    blur: materialConfig.blur,
    saturation: materialConfig.saturation * 100,
    backdropBrightness: materialConfig.brightness,
    backdropContrast: materialConfig.contrast,
    tint,
    tintP3,
    tintRGB,
    highlightOpacity,
    shadowOpacity,
    rimOffsets,
    enableNoise: true,
    legibilityGuard,
  };
}
