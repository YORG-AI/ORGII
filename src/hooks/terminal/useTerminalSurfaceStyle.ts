/**
 * Maps user terminal settings (theme + typography atoms) to inline styles
 * for plain DOM "terminal-like" surfaces (e.g. Simulator replay) without xterm.
 */
import { useAtomValue } from "jotai";
import { type CSSProperties, useMemo } from "react";

import { TERMINAL_LINE_HEIGHT } from "@src/config/terminalAppearance";
import { resolvedTerminalFontFamilyAtom } from "@src/store/ui/editorSettingsAtom";
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → this file's consumers.
import {
  terminalFontSizeAtom,
  terminalLetterSpacingAtom,
  terminalThemeAtom,
} from "@src/store/ui/uiAtom";
import { TERMINAL_THEMES } from "@src/util/ui/terminal/themes";

export interface TerminalSurfaceStyle {
  background: string;
  foreground: string;
  mutedForeground: string;
  errorForeground: string;
  /** Terminal panel font size (px), same atom as xterm / TerminalCore */
  terminalFontSize: number;
  typography: CSSProperties;
  typographyVariables: CSSProperties;
}

export function useTerminalSurfaceStyle(): TerminalSurfaceStyle {
  const terminalThemeName = useAtomValue(terminalThemeAtom);
  const terminalFontSize = useAtomValue(terminalFontSizeAtom);
  const terminalLetterSpacing = useAtomValue(terminalLetterSpacingAtom);
  const terminalFontFamily = useAtomValue(resolvedTerminalFontFamilyAtom);
  return useMemo(() => {
    const palette = TERMINAL_THEMES[terminalThemeName];
    const typography: CSSProperties = {
      fontFamily: terminalFontFamily,
      fontSize: terminalFontSize,
      letterSpacing: terminalLetterSpacing,
      lineHeight: TERMINAL_LINE_HEIGHT,
    };
    const typographyVariables = {
      ["--simulator-shell-font-size" as string]: `${terminalFontSize}px`,
      ["--simulator-shell-font-family" as string]: terminalFontFamily,
      ["--simulator-shell-letter-spacing" as string]: `${terminalLetterSpacing}px`,
      ["--simulator-shell-line-height" as string]: String(TERMINAL_LINE_HEIGHT),
    };

    return {
      background: palette.background,
      foreground: palette.foreground,
      mutedForeground: palette.brightBlack,
      errorForeground: palette.red,
      terminalFontSize,
      typography,
      typographyVariables,
    };
  }, [
    terminalFontFamily,
    terminalFontSize,
    terminalLetterSpacing,
    terminalThemeName,
  ]);
}
