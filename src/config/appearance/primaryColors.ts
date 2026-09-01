export const PRIMARY_COLOR_PRESETS = [
  "blue",
  "violet",
  "green",
  "teal",
  "orange",
  "gold",
  "red",
  "rose",
  "mono",
] as const;

export type PrimaryColorPreset = (typeof PRIMARY_COLOR_PRESETS)[number];

export const COLOR_PRIMARY_VARIABLE_KEYS = [
  "--color-primary-1",
  "--color-primary-2",
  "--color-primary-3",
  "--color-primary-4",
  "--color-primary-5",
  "--color-primary-6",
  "--color-primary-7",
] as const;

export type ColorPrimaryVariableKey =
  (typeof COLOR_PRIMARY_VARIABLE_KEYS)[number];

export type PrimaryPalette = Record<ColorPrimaryVariableKey, string>;

/**
 * Full light/dark primary ramp (--color-primary-1 … --color-primary-7) as hex colors.
 * Pregenerated pair mappings live in `primaryColorSchemas.ts`.
 */
export interface PrimaryColorSchema {
  light: PrimaryPalette;
  dark: PrimaryPalette;
}

const VIOLET_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#f5e8ff",
    "--color-primary-2": "#ddbef6",
    "--color-primary-3": "#c396ed",
    "--color-primary-4": "#a871e3",
    "--color-primary-5": "#8d4eda",
    "--color-primary-6": "#722ed1",
    "--color-primary-7": "#551db0",
  },
  dark: {
    "--color-primary-1": "#261c3a",
    "--color-primary-2": "#371869",
    "--color-primary-3": "#52249a",
    "--color-primary-4": "#6e38c5",
    "--color-primary-5": "#8652dc",
    "--color-primary-6": "#9b6be8",
    "--color-primary-7": "#b790f3",
  },
};

const GREEN_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#e8ffea",
    "--color-primary-2": "#aff0b5",
    "--color-primary-3": "#7be188",
    "--color-primary-4": "#4cd263",
    "--color-primary-5": "#23c343",
    "--color-primary-6": "#00b42a",
    "--color-primary-7": "#009a29",
  },
  dark: {
    "--color-primary-1": "#183020",
    "--color-primary-2": "#0a481e",
    "--color-primary-3": "#0e6c2e",
    "--color-primary-4": "#14943c",
    "--color-primary-5": "#1eb448",
    "--color-primary-6": "#34c759",
    "--color-primary-7": "#5ada78",
  },
};

const TEAL_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#e8fffb",
    "--color-primary-2": "#b7f4ec",
    "--color-primary-3": "#89e9e0",
    "--color-primary-4": "#5edfd6",
    "--color-primary-5": "#37d4cf",
    "--color-primary-6": "#14c9c9",
    "--color-primary-7": "#0da5aa",
  },
  dark: {
    "--color-primary-1": "#162e30",
    "--color-primary-2": "#06464a",
    "--color-primary-3": "#0a6970",
    "--color-primary-4": "#108e94",
    "--color-primary-5": "#1cb2b4",
    "--color-primary-6": "#32cdcd",
    "--color-primary-7": "#60e0de",
  },
};

const ORANGE_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#fff7e8",
    "--color-primary-2": "#ffe4ba",
    "--color-primary-3": "#ffcf8b",
    "--color-primary-4": "#ffb65d",
    "--color-primary-5": "#ff9a2e",
    "--color-primary-6": "#ff7d00",
    "--color-primary-7": "#d25f00",
  },
  dark: {
    "--color-primary-1": "#382614",
    "--color-primary-2": "#583408",
    "--color-primary-3": "#844c0a",
    "--color-primary-4": "#b06610",
    "--color-primary-5": "#d2821e",
    "--color-primary-6": "#f09c34",
    "--color-primary-7": "#ffba64",
  },
};

const GOLD_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#fffce8",
    "--color-primary-2": "#fdf4bf",
    "--color-primary-3": "#fce996",
    "--color-primary-4": "#fadc6d",
    "--color-primary-5": "#f9cc45",
    "--color-primary-6": "#f7ba1e",
    "--color-primary-7": "#cc9213",
  },
  dark: {
    "--color-primary-1": "#322a12",
    "--color-primary-2": "#503e06",
    "--color-primary-3": "#785c0a",
    "--color-primary-4": "#a47e10",
    "--color-primary-5": "#c8a01a",
    "--color-primary-6": "#ebc434",
    "--color-primary-7": "#fada64",
  },
};

const RED_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#ffece8",
    "--color-primary-2": "#fdcdc5",
    "--color-primary-3": "#fbaca3",
    "--color-primary-4": "#f98981",
    "--color-primary-5": "#f76560",
    "--color-primary-6": "#f53f3f",
    "--color-primary-7": "#cb272d",
  },
  dark: {
    "--color-primary-1": "#381c1c",
    "--color-primary-2": "#601416",
    "--color-primary-3": "#8e1e22",
    "--color-primary-4": "#bc2c30",
    "--color-primary-5": "#dc4444",
    "--color-primary-6": "#f06060",
    "--color-primary-7": "#fa8c8c",
  },
};

const ROSE_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#ffe8f1",
    "--color-primary-2": "#fdc2db",
    "--color-primary-3": "#fb9dc7",
    "--color-primary-4": "#f979b7",
    "--color-primary-5": "#f754a8",
    "--color-primary-6": "#f5319d",
    "--color-primary-7": "#cb1e83",
  },
  dark: {
    "--color-primary-1": "#361a28",
    "--color-primary-2": "#581236",
    "--color-primary-3": "#821a52",
    "--color-primary-4": "#ac2870",
    "--color-primary-5": "#d23e8c",
    "--color-primary-6": "#eb5aa6",
    "--color-primary-7": "#f884c2",
  },
};

const MONO_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#ebe9e2",
    "--color-primary-2": "#dcd9d0",
    "--color-primary-3": "#c3c0b7",
    "--color-primary-4": "#afaba2",
    "--color-primary-5": "#78756e",
    "--color-primary-6": "#37352f",
    "--color-primary-7": "#24231e",
  },
  dark: {
    "--color-primary-1": "#2f2d2a",
    "--color-primary-2": "#3e3b36",
    "--color-primary-3": "#524e46",
    "--color-primary-4": "#69655d",
    "--color-primary-5": "#9b978e",
    "--color-primary-6": "#d3d0c8",
    "--color-primary-7": "#ebe9e4",
  },
};

/**
 * Blue is the ramp baked into `orgii_main.css` / `orgii_dark.css`. It used to be
 * a sentinel that meant "emit nothing", but a skin can now repaint
 * `--color-primary-*` from its own accent, so blue needs a real palette to
 * override that with.
 */
const BLUE_PALETTE: PrimaryColorSchema = {
  light: {
    "--color-primary-1": "#e8f8ff",
    "--color-primary-2": "#bfe8ff",
    "--color-primary-3": "#96d6fe",
    "--color-primary-4": "#6ec2fe",
    "--color-primary-5": "#45abfd",
    "--color-primary-6": "#1d8ffd",
    "--color-primary-7": "#126ed1",
  },
  dark: {
    "--color-primary-1": "#1e2a3a",
    "--color-primary-2": "#033479",
    "--color-primary-3": "#0e52a5",
    "--color-primary-4": "#1e74d1",
    "--color-primary-5": "#349afd",
    "--color-primary-6": "#43aafd",
    "--color-primary-7": "#6ec2fe",
  },
};

export const DEFAULT_PRIMARY_COLOR_PRESET: PrimaryColorPreset = "blue";

export const PRIMARY_COLOR_PALETTES: Record<
  PrimaryColorPreset,
  PrimaryColorSchema
> = {
  blue: BLUE_PALETTE,
  violet: VIOLET_PALETTE,
  green: GREEN_PALETTE,
  teal: TEAL_PALETTE,
  orange: ORANGE_PALETTE,
  gold: GOLD_PALETTE,
  red: RED_PALETTE,
  rose: ROSE_PALETTE,
  mono: MONO_PALETTE,
};
