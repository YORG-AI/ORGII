/**
 * Terminal Theme Utilities
 * Converts app themes to XTerm format.
 *
 * Background strategy: xterm owns its background. We resolve --cm-editor-background
 * from the document and pass it as theme.background, matching VSCode's
 * approach. On app theme switches the active terminal's theme is patched via
 * terminal.options.theme = ... (see TerminalInteractive theme effect), so the
 * background tracks the token without recreating the terminal.
 *
 * The cursor is resolved the same way from --terminal-caret, which the themes
 * alias to --color-primary-6 — so the cursor the renderer paints matches the
 * caret of every input, including under a non-default primary-color preset.
 */
import type { ITheme } from "@xterm/xterm";

// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → this file.
import type { TerminalThemeName } from "@src/store/ui/uiAtom";
import { TERMINAL_THEMES } from "@src/util/ui/terminal/themes";

const CSS_VAR_REFERENCE_PATTERN = /^var\(\s*(--[^,\s)]+)\s*(?:,\s*(.+))?\)$/;

function getDocumentColorToken(
  tokenName: string,
  fallback: string,
  seenTokens = new Set<string>()
): string {
  if (typeof window === "undefined") return fallback;
  if (seenTokens.has(tokenName)) return fallback;

  seenTokens.add(tokenName);
  // Read from <body>, not <html>: the theme CSS declares its color tokens
  // (including --color-primary-6, which the primary-color preset then
  // overrides inline) on `body`, and custom properties inherit down from
  // :root — so the body scope resolves both, while :root cannot see the
  // accent at all.
  const scope = document.body ?? document.documentElement;
  const cssVar = getComputedStyle(scope).getPropertyValue(tokenName).trim();
  if (!cssVar) return fallback;

  const referenceMatch = cssVar.match(CSS_VAR_REFERENCE_PATTERN);
  if (!referenceMatch) return cssVar;

  const [, referencedTokenName, referencedFallback] = referenceMatch;
  return getDocumentColorToken(
    referencedTokenName,
    referencedFallback?.trim() || fallback,
    seenTokens
  );
}

/** Read --cm-editor-background from documentElement. */
export function getBgColor(themeName: TerminalThemeName): string {
  return getDocumentColorToken(
    "--cm-editor-background",
    TERMINAL_THEMES[themeName].background
  );
}

function getSelectionColor(themeName: TerminalThemeName): string {
  return getDocumentColorToken(
    "--terminal-selection",
    TERMINAL_THEMES[themeName].selection
  );
}

function getCursorColor(themeName: TerminalThemeName): string {
  return getDocumentColorToken(
    "--terminal-caret",
    TERMINAL_THEMES[themeName].cursor
  );
}

function resolveColorValue(value: string, fallback: string): string {
  const cssVarMatch = value.match(CSS_VAR_REFERENCE_PATTERN);
  if (!cssVarMatch) return value;
  return getDocumentColorToken(cssVarMatch[1], fallback);
}

export function getXTermTheme(
  themeName: TerminalThemeName,
  backgroundOverride?: string
): ITheme {
  const theme = TERMINAL_THEMES[themeName];
  const bg = backgroundOverride
    ? resolveColorValue(backgroundOverride, getBgColor(themeName))
    : getBgColor(themeName);
  return {
    background: bg,
    foreground: theme.foreground,
    cursor: getCursorColor(themeName),
    cursorAccent: bg,
    selectionBackground: getSelectionColor(themeName),
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}
