/**
 * Terminal Themes
 *
 * Simplified to dark/light themes that auto-sync with app theme.
 * Background color is dynamically set from CSS variable --cm-editor-background.
 * The static `background` field below is a fallback for SSR / pre-mount.
 */
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → consumers of this file.
import type { TerminalThemeName } from "@src/store/ui/uiAtom";

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** CSS custom property names for ANSI colors, consumed by .ansi-*-fg / .ansi-*-bg classes. */
export const ANSI_COLOR_CSS_KEYS = [
  "--ansi-black",
  "--ansi-red",
  "--ansi-green",
  "--ansi-yellow",
  "--ansi-blue",
  "--ansi-magenta",
  "--ansi-cyan",
  "--ansi-white",
  "--ansi-bright-black",
  "--ansi-bright-red",
  "--ansi-bright-green",
  "--ansi-bright-yellow",
  "--ansi-bright-blue",
  "--ansi-bright-magenta",
  "--ansi-bright-cyan",
  "--ansi-bright-white",
] as const;

/** Returns a map of CSS custom properties → color values for the given theme. */
export function getAnsiColorCssVars(
  themeName: TerminalThemeName
): Record<string, string> {
  const theme = TERMINAL_THEMES[themeName];
  return {
    "--ansi-black": theme.black,
    "--ansi-red": theme.red,
    "--ansi-green": theme.green,
    "--ansi-yellow": theme.yellow,
    "--ansi-blue": theme.blue,
    "--ansi-magenta": theme.magenta,
    "--ansi-cyan": theme.cyan,
    "--ansi-white": theme.white,
    "--ansi-bright-black": theme.brightBlack,
    "--ansi-bright-red": theme.brightRed,
    "--ansi-bright-green": theme.brightGreen,
    "--ansi-bright-yellow": theme.brightYellow,
    "--ansi-bright-blue": theme.brightBlue,
    "--ansi-bright-magenta": theme.brightMagenta,
    "--ansi-bright-cyan": theme.brightCyan,
    "--ansi-bright-white": theme.brightWhite,
  };
}

export const TERMINAL_THEMES: Record<TerminalThemeName, TerminalTheme> = {
  dark: {
    background: "#141414",
    foreground: "#e4e4e7",
    // Pre-mount fallback only; the live cursor comes from --terminal-caret
    // (aliased to --color-primary-6). Keep in sync with the dark theme's
    // default --color-primary-6 so the first paint is not a different color.
    cursor: "#43aafd",
    cursorAccent: "#141414",
    selection: "#212121",
    black: "#09090b",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#22d3ee",
    white: "#e4e4e7",
    brightBlack: "#52525b",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#fafafa",
  },
  light: {
    background: "#fafafa",
    foreground: "#1f2937",
    // Pre-mount fallback only — see the dark theme's cursor note.
    cursor: "#1d8ffd",
    cursorAccent: "#fafafa",
    selection: "#efefef",
    black: "#1f2937",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    // ANSI "white" on a light background must be dark enough to read;
    // the standard #f3f4f6 is nearly invisible against white.
    white: "#374151",
    brightBlack: "#6b7280",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#111827",
  },
};
