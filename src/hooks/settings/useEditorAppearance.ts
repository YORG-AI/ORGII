/**
 * useEditorAppearance Hook
 *
 * Applies editor appearance settings as CSS custom properties.
 * These CSS variables are consumed by CodeMirror and other editor components.
 *
 * Settings applied:
 * - --code-font-family: Font family for all code surfaces
 * - --cm-font-family: Font family for CodeMirror (mirrors --code-font-family)
 * - --cm-font-size: Font size in pixels
 * - --cm-line-height: Line height multiplier
 * - --cm-tab-size: Tab width (CSS tab-size property)
 * Theme color variables such as --cm-editor-background come from the active
 * public app theme CSS file, layered with the active skin's tokens (see
 * useAppSkin) — not from runtime editor-theme settings.
 */
import { useAtomValue } from "jotai";
import { useEffect } from "react";

import {
  type EditorLineNumbers,
  editorFontSizeAtom,
  editorHighlightActiveLineAtom,
  editorLineHeightAtom,
  editorLineNumbersAtom,
  editorShowIndentGuidesAtom,
  editorShowMinimapAtom,
  editorShowTreeIndentGuidesAtom,
  editorTabSizeAtom,
  editorWordWrapAtom,
  resolvedCodeFontFamilyAtom,
} from "@src/store/ui/editorSettingsAtom";
import { isDarkThemeAtom } from "@src/store/ui/uiAtom";
import {
  ANSI_COLOR_CSS_KEYS,
  getAnsiColorCssVars,
} from "@src/util/ui/terminal/themes";

/**
 * Editor appearance settings object
 */
export interface EditorAppearanceSettings {
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  fontFamily: string;
  lineNumbers: EditorLineNumbers;
  wordWrap: boolean;
  showMinimap: boolean;
  showIndentGuides: boolean;
  showTreeIndentGuides: boolean;
  highlightActiveLine: boolean;
}

/**
 * Hook to read all editor appearance settings
 * Returns the current values for use in components
 */
export function useEditorAppearanceSettings(): EditorAppearanceSettings {
  const fontSize = useAtomValue(editorFontSizeAtom);
  const lineHeight = useAtomValue(editorLineHeightAtom);
  const tabSize = useAtomValue(editorTabSizeAtom);
  const fontFamily = useAtomValue(resolvedCodeFontFamilyAtom);
  const lineNumbers = useAtomValue(editorLineNumbersAtom);
  const wordWrap = useAtomValue(editorWordWrapAtom);
  const showMinimap = useAtomValue(editorShowMinimapAtom);
  const showIndentGuides = useAtomValue(editorShowIndentGuidesAtom);
  const showTreeIndentGuides = useAtomValue(editorShowTreeIndentGuidesAtom);
  const highlightActiveLine = useAtomValue(editorHighlightActiveLineAtom);

  return {
    fontSize,
    lineHeight,
    tabSize,
    fontFamily,
    lineNumbers,
    wordWrap,
    showMinimap,
    showIndentGuides,
    showTreeIndentGuides,
    highlightActiveLine,
  };
}

/**
 * Hook to apply editor appearance settings as CSS custom properties
 * Call this once at the app root level to apply settings globally
 */
export function useEditorAppearanceStyles(): void {
  const fontSize = useAtomValue(editorFontSizeAtom);
  const lineHeight = useAtomValue(editorLineHeightAtom);
  const tabSize = useAtomValue(editorTabSizeAtom);
  const fontFamily = useAtomValue(resolvedCodeFontFamilyAtom);
  const isDark = useAtomValue(isDarkThemeAtom);

  useEffect(() => {
    const root = document.documentElement;

    root.style.setProperty("--code-font-family", fontFamily);
    root.style.setProperty("--cm-font-family", fontFamily);

    root.style.setProperty("--cm-font-size", `${fontSize}px`);
    root.style.setProperty(
      "--cm-font-size-small",
      `${Math.max(fontSize - 1, 10)}px`
    );
    root.style.setProperty("--cm-line-height", String(lineHeight));
    root.style.setProperty("--cm-tab-size", String(tabSize));

    return () => {
      root.style.removeProperty("--code-font-family");
      root.style.removeProperty("--cm-font-family");
      root.style.removeProperty("--cm-font-size");
      root.style.removeProperty("--cm-font-size-small");
      root.style.removeProperty("--cm-line-height");
      root.style.removeProperty("--cm-tab-size");
    };
  }, [fontSize, lineHeight, tabSize, fontFamily]);
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.style.setProperty("color-scheme", isDark ? "dark" : "light");
    const vars = getAnsiColorCssVars(isDark ? "dark" : "light");
    Object.entries(vars).forEach(([key, value]) => {
      body.style.setProperty(key, value);
    });
    return () => {
      root.style.removeProperty("color-scheme");
      ANSI_COLOR_CSS_KEYS.forEach((key) => {
        body.style.removeProperty(key);
      });
    };
  }, [isDark]);
}

export default useEditorAppearanceSettings;
