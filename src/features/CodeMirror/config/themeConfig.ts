/**
 * CodeMirror Theme Configuration
 *
 * Theme selection, font constants, and base theme extension.
 * Uses CSS variables from the active public theme CSS.
 */
import { Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createGithubTheme } from "../themes";

// ============================================
// Font Configuration
// Uses CSS variables from the active public theme CSS
// ============================================

export const CODE_FONT_FAMILY = "var(--cm-font-family)";
export const CODE_FONT_SIZE = "var(--cm-font-size)";
export const CODE_FONT_SIZE_SMALL = "var(--cm-font-size-small)";
export const CODE_LINE_HEIGHT = "var(--cm-line-height)";

// ============================================
// Centralized Theme
// ============================================

/**
 * Both theme factories below return a cached singleton rather than a fresh
 * extension per call.
 *
 * `createGithubTheme()` builds an `EditorView.theme` plus a `HighlightStyle`,
 * i.e. two style-mod `StyleModule`s. style-mod mounts a module's rules into
 * the document and never removes them again — its own docs say to "treat them
 * as one-time allocations". `@uiw/react-codemirror` reconfigures whenever the
 * `theme` extension's identity changes, and `Editor/index.tsx` calls this from
 * its render body, so before this cache every render mounted a fresh set of
 * CSS rules that outlived the editor.
 *
 * A single instance stays correct across app-theme swaps: every color in these
 * themes is a `var(--…)` reference resolved at paint time (see
 * `themes/github.ts`), so the JS objects hold no palette of their own.
 *
 * Cached lazily so the module stays free of declaration-order constraints —
 * the theme constants these read are declared further down this file.
 */
let cachedCodeMirrorTheme: Extension | null = null;

/**
 * Get the app-theme-backed CodeMirror theme.
 */
export function getCodeMirrorTheme(): Extension {
  if (!cachedCodeMirrorTheme) {
    cachedCodeMirrorTheme = [
      createGithubTheme(),
      CODEMIRROR_VISUAL_OVERRIDE_THEME,
    ];
  }
  return cachedCodeMirrorTheme;
}

// ============================================
// Theme Extension
// ============================================

/**
 * Creates a consistent theme extension for CodeMirror
 */
export const CODEMIRROR_VISUAL_OVERRIDE_THEME = Prec.highest(
  EditorView.theme({
    "& .cm-content": {
      caretColor: "var(--cm-editor-caret, var(--color-primary-6)) !important",
    },
    "& .cm-cursor, &.cm-focused .cm-cursor, & .cm-dropCursor": {
      borderLeft:
        "2px solid var(--cm-editor-caret, var(--color-primary-6)) !important",
      borderRight: "none !important",
      borderTop: "none !important",
      borderBottom: "none !important",
      boxSizing: "border-box !important",
    },
    "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground, &.cm-editor.cm-focused .cm-selectionBackground, & .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-selectionLayer .cm-selectionBackground, &.cm-editor.cm-focused .cm-selectionLayer .cm-selectionBackground, & .cm-line .cm-selectionBackground, & .cm-selectionMatch":
      {
        background:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
        backgroundColor:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
        opacity: "1 !important",
      },
    "& .cm-content::selection, & .cm-content ::selection, & .cm-line::selection, & .cm-line ::selection, & .cm-line span::selection, & .cm-line del::selection, & .cm-deletedChunk ::selection, & .cm-insertedChunk ::selection":
      {
        background:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
        backgroundColor:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
      },
    "& .cm-content::-moz-selection, & .cm-content ::-moz-selection, & .cm-line::-moz-selection, & .cm-line ::-moz-selection, & .cm-line span::-moz-selection, & .cm-line del::-moz-selection, & .cm-deletedChunk ::-moz-selection, & .cm-insertedChunk ::-moz-selection":
      {
        background:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
        backgroundColor:
          "var(--cm-editor-selection, var(--color-fill-2)) !important",
      },
  })
);

export const CODEMIRROR_BASE_LAYOUT_THEME = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: CODE_FONT_SIZE,
    fontFamily: CODE_FONT_FAMILY,
    backgroundColor: "var(--cm-editor-background)",
  },
  ".cm-scroller": {
    fontFamily: CODE_FONT_FAMILY,
    lineHeight: CODE_LINE_HEIGHT,
    overflow: "auto",
  },
  ".cm-content": {
    fontFamily: CODE_FONT_FAMILY,
  },
  ".cm-gutters": {
    fontFamily: CODE_FONT_FAMILY,
    borderRight: "none",
    border: "none",
    backgroundColor: "var(--cm-editor-gutter-bg, var(--cm-editor-background))",
  },
  ".cm-lineNumbers": {
    borderRight: "none",
    paddingLeft: "var(--cm-line-number-padding-left, 8px)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    borderRight: "none",
  },
  ".cm-line": {
    padding:
      "0 var(--cm-line-padding-right, 16px) 0 var(--cm-line-padding-left, 12px)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-panels-top": {
    background: "transparent",
    backgroundColor: "transparent",
    border: "none",
    borderBottom: "none",
  },
  "& .cm-panels-top": {
    background: "transparent",
    backgroundColor: "transparent",
    border: "none",
    borderBottom: "none",
  },
});

let cachedCodeMirrorLayoutTheme: Extension | null = null;

export function createCodeMirrorTheme(): Extension {
  if (!cachedCodeMirrorLayoutTheme) {
    cachedCodeMirrorLayoutTheme = [
      CODEMIRROR_BASE_LAYOUT_THEME,
      CODEMIRROR_VISUAL_OVERRIDE_THEME,
    ];
  }
  return cachedCodeMirrorLayoutTheme;
}
