/**
 * Pregenerated primary ramps for each background color preset.
 *
 * Keys mirror `BACKGROUND_COLOR_PRESETS[].id`. Values reference the same objects
 * as `PRIMARY_COLOR_PALETTES` (shared memory). Use for "accent follows
 * background" without sampling hex or images at runtime.
 */
import { BACKGROUND_COLOR_PRESETS } from "./backgroundColors";
import {
  PRIMARY_COLOR_PALETTES,
  type PrimaryColorSchema,
} from "./primaryColors";

type BackgroundColorPresetId = (typeof BACKGROUND_COLOR_PRESETS)[number]["id"];

type NonBluePreset = keyof typeof PRIMARY_COLOR_PALETTES;

/** Curated primary preset per background color name / hue. */
const BACKGROUND_COLOR_TO_PRESET: Record<
  BackgroundColorPresetId,
  NonBluePreset
> = {
  classic: "mono",
  graphite: "mono",
  slate: "teal",
  midnight: "violet",
  ocean: "teal",
  sky: "teal",
  indigo: "violet",
  teal: "teal",
  forest: "green",
  mint: "green",
  sage: "green",
  lavender: "violet",
  plum: "violet",
  rose: "rose",
  crimson: "red",
  peach: "orange",
  amber: "gold",
  sand: "gold",
  coffee: "orange",
};

function buildBackgroundColorSchemas(): Record<
  BackgroundColorPresetId,
  PrimaryColorSchema
> {
  const out = {} as Record<BackgroundColorPresetId, PrimaryColorSchema>;
  for (const key of Object.keys(
    BACKGROUND_COLOR_TO_PRESET
  ) as BackgroundColorPresetId[]) {
    const preset = BACKGROUND_COLOR_TO_PRESET[key];
    out[key] = PRIMARY_COLOR_PALETTES[preset];
  }
  return out;
}

/** Full `--primary-*` schema for every bundled background color ID. */
export const PRIMARY_SCHEMA_BY_BACKGROUND_COLOR_ID: Record<
  BackgroundColorPresetId,
  PrimaryColorSchema
> = buildBackgroundColorSchemas();

export function getPrimarySchemaForBackgroundColorId(
  colorId: string | undefined
): PrimaryColorSchema | null {
  if (!colorId || !(colorId in PRIMARY_SCHEMA_BY_BACKGROUND_COLOR_ID)) {
    return null;
  }
  return PRIMARY_SCHEMA_BY_BACKGROUND_COLOR_ID[
    colorId as BackgroundColorPresetId
  ];
}
