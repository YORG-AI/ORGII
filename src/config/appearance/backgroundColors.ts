/**
 * Background Color Presets
 *
 * Preset app background colors are stable IDs mapped to `--app-bg-*` theme
 * slots. Each public theme defines those slots, so the selected ID remains
 * stable while the rendered value follows the active theme.
 */

export interface BackgroundColorPreset {
  id: string;
  label: string;
  description: string;
  cssVar: `--app-bg-${number}`;
}

export const BACKGROUND_COLOR_PRESETS = [
  {
    id: "classic",
    label: "Classic",
    description: "Warm paper & ink",
    cssVar: "--app-bg-1",
  },
  {
    id: "graphite",
    label: "Graphite",
    description: "Neutral grays",
    cssVar: "--app-bg-2",
  },
  {
    id: "slate",
    label: "Slate",
    description: "Cool blue gray",
    cssVar: "--app-bg-3",
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Deep navy",
    cssVar: "--app-bg-4",
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep blue",
    cssVar: "--app-bg-5",
  },
  {
    id: "sky",
    label: "Sky",
    description: "Open sky",
    cssVar: "--app-bg-6",
  },
  {
    id: "indigo",
    label: "Indigo",
    description: "Twilight indigo",
    cssVar: "--app-bg-7",
  },
  {
    id: "teal",
    label: "Teal",
    description: "Deep teal",
    cssVar: "--app-bg-8",
  },
  {
    id: "forest",
    label: "Forest",
    description: "Pine green",
    cssVar: "--app-bg-9",
  },
  {
    id: "mint",
    label: "Mint",
    description: "Fresh mint",
    cssVar: "--app-bg-10",
  },
  {
    id: "sage",
    label: "Sage",
    description: "Muted sage",
    cssVar: "--app-bg-11",
  },
  {
    id: "lavender",
    label: "Lavender",
    description: "Soft purple",
    cssVar: "--app-bg-12",
  },
  {
    id: "plum",
    label: "Plum",
    description: "Rich plum",
    cssVar: "--app-bg-13",
  },
  {
    id: "rose",
    label: "Rose",
    description: "Warm rose",
    cssVar: "--app-bg-14",
  },
  {
    id: "crimson",
    label: "Crimson",
    description: "Deep crimson",
    cssVar: "--app-bg-15",
  },
  {
    id: "peach",
    label: "Peach",
    description: "Soft peach",
    cssVar: "--app-bg-16",
  },
  {
    id: "amber",
    label: "Amber",
    description: "Warm amber",
    cssVar: "--app-bg-17",
  },
  {
    id: "sand",
    label: "Sand",
    description: "Warm paper",
    cssVar: "--app-bg-18",
  },
  {
    id: "coffee",
    label: "Coffee",
    description: "Roasted coffee",
    cssVar: "--app-bg-19",
  },
] as const satisfies BackgroundColorPreset[];

export function getBackgroundColorPresetById(
  id: string | undefined
): BackgroundColorPreset | null {
  if (!id) return null;
  return BACKGROUND_COLOR_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function resolveBackgroundColorPreset(
  preset: BackgroundColorPreset
): string {
  return `var(${preset.cssVar})`;
}
