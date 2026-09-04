/**
 * Accent (primary color) resolution, per light/dark variant.
 *
 * The accent is chosen independently for each variant, so a user can run, say,
 * a warm accent in light and a cool one in dark. `matchSkin` defers to whatever
 * the active skin declares — for a baseline skin that means "change nothing",
 * which is why it is the default: existing installs keep the exact ramp their
 * stylesheet already ships.
 */
import {
  COLOR_PRIMARY_VARIABLE_KEYS,
  PRIMARY_COLOR_PALETTES,
  PRIMARY_COLOR_PRESETS,
  type PrimaryColorPreset,
  type PrimaryPalette,
} from "@src/config/appearance/primaryColors";

import { buildRamp } from "./color";
import type { SkinSeed, SkinVariant } from "./types";

export const MATCH_SKIN_ACCENT = "matchSkin" as const;

export const ACCENT_PRESETS = [
  MATCH_SKIN_ACCENT,
  ...PRIMARY_COLOR_PRESETS,
] as const;

export type AccentPreset = (typeof ACCENT_PRESETS)[number];

export const DEFAULT_ACCENT_PRESET: AccentPreset = MATCH_SKIN_ACCENT;

export function isAccentPreset(value: unknown): value is AccentPreset {
  return (
    typeof value === "string" &&
    (ACCENT_PRESETS as readonly string[]).includes(value)
  );
}

export function normalizeAccentPreset(value: unknown): AccentPreset {
  return isAccentPreset(value) ? value : DEFAULT_ACCENT_PRESET;
}

/**
 * The palette to write onto `--color-primary-*`, or `null` when the caller
 * should leave those tokens to the skin (or, for baseline skins, to the base
 * stylesheet).
 */
export function resolveAccentPalette(
  preset: AccentPreset,
  variant: SkinVariant
): PrimaryPalette | null {
  if (preset === MATCH_SKIN_ACCENT) return null;
  return PRIMARY_COLOR_PALETTES[preset as PrimaryColorPreset][variant];
}

/** The swatch color shown next to an accent option in the picker. */
export function getAccentSwatch(
  preset: AccentPreset,
  variant: SkinVariant,
  seed: SkinSeed
): string {
  if (preset === MATCH_SKIN_ACCENT) return seed.accent;
  return PRIMARY_COLOR_PALETTES[preset as PrimaryColorPreset][variant][
    "--color-primary-6"
  ];
}

/**
 * Accent ramp for a skin that has no explicit primary scale — used when the
 * accent preset is `matchSkin` and the skin is not a baseline one.
 */
export function buildSkinAccentPalette(
  seed: SkinSeed,
  variant: SkinVariant
): PrimaryPalette {
  const ramp = buildRamp(seed.accent, seed.surface, variant);
  const palette = {} as PrimaryPalette;
  COLOR_PRIMARY_VARIABLE_KEYS.forEach((key, index) => {
    palette[key] = ramp[index];
  });
  return palette;
}
