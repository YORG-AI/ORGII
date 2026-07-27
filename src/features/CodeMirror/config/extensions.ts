/**
 * CodeMirror Editor Extensions
 *
 * Indentation guides, fold gutter, and fold placeholder styling.
 */
import { redo, undo } from "@codemirror/commands";
import { foldGutter } from "@codemirror/language";
import { Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

// Re-export find/replace extension from Workstation CodeEditor
export { findReplaceExtension } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/components/CodeMirrorSearchPanel";

// ============================================
// History Keymap Extension
// ============================================

export function editorHistoryKeymapExtension(): Extension {
  return Prec.highest(
    keymap.of([
      { key: "Mod-z", run: undo },
      { key: "Mod-Shift-z", run: redo },
      { key: "Ctrl-y", run: redo },
    ])
  );
}

// ============================================
// Indentation Guides Extension
// ============================================

/**
 * Indentation guides extension
 */
export function indentGuidesExtension(): Extension {
  return indentationMarkers({
    thickness: 1,
    activeThickness: 1,
    colors: {
      light: "var(--color-border-2)",
      dark: "var(--color-border-2)",
      activeLight: "var(--color-border-2)",
      activeDark: "var(--color-border-2)",
    },
  });
}

// ============================================
// Fold Gutter Extension
// ============================================

/**
 * Custom fold gutter with aligned markers
 */
export function customFoldGutter(): Extension {
  return foldGutter({
    markerDOM: (open: boolean) => {
      const span = document.createElement("span");
      span.textContent = open ? "⌄" : "›";
      // Different vertical offset for each icon due to different baselines
      const translateY = open ? "-3px" : "0px";
      span.style.cssText = `
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--cm-icon-size, 14px);
        height: 100%;
        line-height: 1;
        cursor: var(--interactive-cursor, default);
        user-select: none;
        transform: translateY(${translateY});
      `;
      span.setAttribute("title", open ? "Fold line" : "Unfold line");
      return span;
    },
  });
}

/**
 * Theme extension for fold placeholder styling
 * Use this alongside customFoldGutter() for consistent styling
 */
export function foldPlaceholderTheme(): Extension {
  return EditorView.baseTheme({
    ".cm-foldPlaceholder": {
      display: "inline-flex !important",
      alignItems: "center !important",
      justifyContent: "center !important",
      padding: "0 var(--cm-gutter-padding, 4px) !important",
      margin: "0 2px !important",
      fontSize: "var(--cm-font-size-small, 12px) !important",
      color: "var(--color-text-3) !important",
      backgroundColor: "var(--color-fill-1) !important",
      border: "1px solid var(--color-border-2) !important",
      borderRadius: "var(--cm-border-radius-small, 2px) !important",
      cursor: "var(--interactive-cursor, default) !important",
      userSelect: "none !important",
      verticalAlign: "middle !important",
      lineHeight: "1 !important",
    },
  });
}
