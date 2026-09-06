/**
 * Color Analysis Utilities
 *
 * Semantic color analysis for configured solid surfaces.
 * Converts between color spaces and determines color temperature.
 */
import type { SurfaceColorField } from "./types";

/**
 * Convert RGB to HSL
 */
export function rgbToHsl(
  r: number,
  g: number,
  b: number
): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;

  let hue = 0;
  let saturation = 0;

  if (max !== min) {
    const delta = max - min;
    saturation =
      lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    switch (max) {
      case r:
        hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        hue = ((b - r) / delta + 2) / 6;
        break;
      case b:
        hue = ((r - g) / delta + 4) / 6;
        break;
    }
  }

  return { h: hue * 360, s: saturation, l: lightness };
}

export function resolveCssColorValue(color: string): string {
  const variableMatch = color.trim().match(/^var\((--[^),\s]+)(?:,[^)]+)?\)$/);
  if (!variableMatch || typeof document === "undefined") {
    return color;
  }

  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variableMatch[1])
    .trim();
  return value || color;
}

/**
 * Parse a CSS color string to RGB values
 * Supports hex colors (#RGB, #RRGGBB), rgb/rgba, and simple CSS variables.
 */
export function parseCssColor(
  color: string
): { r: number; g: number; b: number } | null {
  const resolvedColor = resolveCssColorValue(color).trim();

  // Handle hex colors
  if (resolvedColor.startsWith("#")) {
    let hex = resolvedColor.slice(1);
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    if (hex.length === 6) {
      const red = parseInt(hex.slice(0, 2), 16);
      const green = parseInt(hex.slice(2, 4), 16);
      const blue = parseInt(hex.slice(4, 6), 16);
      if (!isNaN(red) && !isNaN(green) && !isNaN(blue)) {
        return { r: red, g: green, b: blue };
      }
    }
  }

  // Handle rgb/rgba
  const rgbMatch = resolvedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1]),
      g: parseInt(rgbMatch[2]),
      b: parseInt(rgbMatch[3]),
    };
  }

  return null;
}

/**
 * Determine color temperature from hue
 */
export function getColorTemperature(hue: number): "warm" | "cool" | "neutral" {
  // Warm: reds, oranges, yellows (0-60, 300-360)
  // Cool: greens, blues, purples (120-270)
  // Neutral: transitional zones
  if ((hue >= 0 && hue < 30) || (hue >= 330 && hue <= 360)) return "warm";
  if (hue >= 30 && hue < 90) return "warm";
  if (hue >= 180 && hue < 270) return "cool";
  if (hue >= 90 && hue < 150) return "cool";
  return "neutral";
}

/**
 * Create a SurfaceColorField from a CSS color string
 */
export function colorFieldFromCssColor(color: string): SurfaceColorField {
  const defaultField: SurfaceColorField = {
    dominantHue: 0,
    saturation: 0.05,
    luminance: 0.5,
    temperature: "neutral",
    dominantRGB: { r: 128, g: 128, b: 128 },
  };

  const rgb = parseCssColor(color);
  if (!rgb) return defaultField;

  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

  return {
    dominantHue: hsl.h,
    saturation: hsl.s,
    luminance: hsl.l,
    temperature: getColorTemperature(hsl.h),
    dominantRGB: rgb,
  };
}

/** Default neutral color field (used as fallback) */
export const DEFAULT_COLOR_FIELD: SurfaceColorField = {
  dominantHue: 0,
  saturation: 0.05,
  luminance: 0.5,
  temperature: "neutral",
  dominantRGB: { r: 128, g: 128, b: 128 },
};
