/**
 * Minimal sRGB color math for skin token derivation.
 *
 * Kept dependency-free and synchronous: `deriveSkinTokens` runs on every theme
 * swap and on first paint, so it must not pull in a color library or allocate
 * beyond the token record it returns.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_PATTERN = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Parse `#rgb` / `#rrggbb`. Returns null for anything else (including alpha hex). */
export function parseHex(value: string | null | undefined): Rgb | null {
  if (!value) return null;
  const hex = value.trim();
  if (!HEX_PATTERN.test(hex)) return null;
  const body =
    hex.length === 4
      ? hex
          .slice(1)
          .split("")
          .map((char) => char + char)
          .join("")
      : hex.slice(1);
  return {
    r: Number.parseInt(body.slice(0, 2), 16),
    g: Number.parseInt(body.slice(2, 4), 16),
    b: Number.parseInt(body.slice(4, 6), 16),
  };
}

function channelToHex(value: number): string {
  return Math.round(clamp(value, 0, 255))
    .toString(16)
    .padStart(2, "0");
}

export function formatHex(color: Rgb): string {
  return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}`;
}

/** Linear blend of `from` toward `to`. `amount` is 0–1. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const ratio = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  };
}

export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (!a || !b) return from;
  return formatHex(mix(a, b, amount));
}

export function rgba(color: Rgb, alpha: number): string {
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(clamp(alpha, 0, 1).toFixed(3))})`;
}

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) – 1 (white). */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * toLinear(color.r) +
    0.7152 * toLinear(color.g) +
    0.0722 * toLinear(color.b)
  );
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

export function isDarkColor(color: Rgb): boolean {
  return relativeLuminance(color) < 0.5;
}

/**
 * Pick whichever of `#ffffff` / `#000000` reads better on `background`.
 * Used for text that sits directly on an accent or semantic fill.
 */
export function readableOn(background: Rgb): string {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  return contrastRatio(background, white) >= contrastRatio(background, black)
    ? "#ffffff"
    : "#000000";
}

/**
 * Build a 7-stop ramp for `color` against `surface`, matching the shape of the
 * app's `--color-*-1 … -7` scales: stops 1–5 progress from a bare tint of the
 * surface up toward the full color, **stop 6 is the color itself**, and stop 7
 * is the emphasis step past it.
 *
 * Stop 6 carrying the unmodified color is load-bearing, not cosmetic:
 * `--color-primary-6` is what the design system means by "the accent", and
 * `--cm-editor-caret` / `--terminal-caret` alias straight to it. Both variants
 * therefore anchor on the same index; only the direction of stop 7 differs,
 * because emphasis reads as darker on a light surface and brighter on a dark one.
 */
export function buildRamp(
  color: string,
  surface: string,
  variant: "light" | "dark"
): string[] {
  const base = parseHex(color);
  const bg = parseHex(surface);
  if (!base || !bg) return Array.from({ length: 7 }, () => color);

  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  const approach =
    variant === "light"
      ? [0.92, 0.76, 0.58, 0.4, 0.2]
      : [0.86, 0.7, 0.52, 0.33, 0.14];

  return [
    ...approach.map((amount) => formatHex(mix(base, bg, amount))),
    formatHex(base),
    formatHex(
      variant === "light" ? mix(base, black, 0.22) : mix(base, white, 0.28)
    ),
  ];
}
