/**
 * useEditorExtensions Hook
 *
 * Builds the CodeMirror extensions array based on feature flags and settings.
 * This is the main orchestrator for all editor extensions.
 */
import { autocompletion } from "@codemirror/autocomplete";
import { indentUnit } from "@codemirror/language";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { RefObject, useMemo } from "react";

import { useEditorAppearanceSettings } from "@src/hooks/settings";

import type { BlameLineData } from "../../config";
import {
  codeMirrorCspNonceExtension,
  createCodeMirrorTheme,
  customFoldGutter,
  dirtyDiffGutter,
  editorHistoryKeymapExtension,
  findReplaceExtension,
  foldPlaceholderTheme,
  gitBlameExtension,
  goToLineExtension,
  indentGuidesExtension,
  minimapExtension,
} from "../../config";

// ============================================
// Types
// ============================================

export interface UseEditorExtensionsOptions {
  /** Original value ref for dirty diff */
  originalValueRef: RefObject<string>;
  /** Whether dirty diff is enabled */
  enableDirtyDiff: boolean;
  /** Original value (used to trigger extension recreation) */
  originalValue?: string;
  /** Whether file is deleted (for dirty diff) */
  isDeletedFile: boolean;
  /** Whether go-to-line is enabled */
  enableGoToLine: boolean;
  /** Whether find/replace is enabled */
  enableFindReplace: boolean;
  /** Effective minimap setting (after large file check) */
  effectiveMinimap: boolean;
  /** Effective indent guides setting (after large file check) */
  effectiveIndentGuides: boolean;
  /** Effective linting setting (after large file check) */
  /** Lazy-loaded language extension */
  lazyLangExtension: Extension | null;
  /** Cursor tracking extension */
  cursorExtension: Extension | null;
  /** Selection tracking extension */
  selectionExtension: Extension | null;
  /** Copy handler extension */
  copyExtension: Extension | null;
  /** Ref to minimap host element */
  minimapHostRef: RefObject<HTMLDivElement | null>;
  /** Whether inline git blame is enabled */
  enableGitBlame?: boolean;
  /** Ref to blame data map (line number -> BlameLineData) */
  blameDataRef?: RefObject<Map<number, BlameLineData>>;
  /** 1-indexed file line of the first document line (default: 1). */
  lineNumberStart?: number;
}

// ============================================
// Hook
// ============================================

/**
 * Hook to build the complete CodeMirror extensions array
 * Optimized to only recreate when structural changes occur
 */
export function useEditorExtensions(
  options: UseEditorExtensionsOptions
): Extension[] {
  const {
    originalValueRef,
    enableDirtyDiff,
    originalValue,
    isDeletedFile,
    enableGoToLine,
    enableFindReplace,
    effectiveMinimap,
    effectiveIndentGuides,
    lazyLangExtension,
    cursorExtension,
    selectionExtension,
    copyExtension,
    minimapHostRef,
    enableGitBlame,
    blameDataRef,
    lineNumberStart,
  } = options;

  const appearanceSettings = useEditorAppearanceSettings();

  // Create git blame extension when enabled
  const gitBlameExt = useMemo(() => {
    if (!enableGitBlame || !blameDataRef) {
      return null;
    }
    return gitBlameExtension(blameDataRef);
  }, [enableGitBlame, blameDataRef]);

  const themeExtension = useMemo(() => createCodeMirrorTheme(), []);

  // Create dirty diff extension when originalValue is provided or changes
  const dirtyDiffExtension = useMemo(() => {
    if (!enableDirtyDiff || originalValue === undefined) {
      return null;
    }
    return dirtyDiffGutter(
      originalValueRef as { current: string },
      isDeletedFile
    );
  }, [enableDirtyDiff, originalValue, isDeletedFile, originalValueRef]);

  // Build extensions array
  return useMemo(() => {
    // Override panels-top styles with highest priority
    const panelsOverride = EditorView.baseTheme({
      "&.cm-editor .cm-panels-top": {
        background: "transparent !important",
        backgroundColor: "transparent !important",
        border: "none !important",
        borderBottom: "none !important",
      },
      ".cm-panels.cm-panels-top": {
        background: "transparent !important",
        backgroundColor: "transparent !important",
        border: "none !important",
        borderBottom: "none !important",
      },
    });

    const exts: Extension[] = [
      codeMirrorCspNonceExtension,
      panelsOverride,
      editorHistoryKeymapExtension(),
      autocompletion({ icons: false }),
      themeExtension,
    ];

    // Custom line number modes (relative and interval)
    // IMPORTANT: Add BEFORE fold gutter to maintain correct visual order
    // A ranged-excerpt offset (lineNumberStart > 1) takes precedence so the
    // gutter shows real file line numbers; basicSetup's lineNumbers is
    // disabled by the editor component in that case.
    const lineNumberOffset =
      lineNumberStart && lineNumberStart > 1 ? lineNumberStart - 1 : 0;
    if (lineNumberOffset > 0) {
      exts.push(
        lineNumbers({
          formatNumber: (lineNo: number) => String(lineNo + lineNumberOffset),
        })
      );
    } else if (appearanceSettings.lineNumbers === "relative") {
      exts.push(
        lineNumbers({
          formatNumber: (lineNo: number, state: EditorState) => {
            const cursorLine = state.doc.lineAt(
              state.selection.main.head
            ).number;
            if (lineNo === cursorLine) {
              return String(lineNo);
            }
            return String(Math.abs(lineNo - cursorLine));
          },
        })
      );
    } else if (appearanceSettings.lineNumbers === "interval") {
      exts.push(
        lineNumbers({
          formatNumber: (lineNo: number) => {
            if (lineNo === 1 || lineNo % 10 === 0) {
              return String(lineNo);
            }
            return "";
          },
        })
      );
    }

    // Fold gutter (after line numbers for correct visual order)
    exts.push(customFoldGutter());
    exts.push(foldPlaceholderTheme());

    // Word wrap support
    if (appearanceSettings.wordWrap) {
      exts.push(EditorView.lineWrapping);
    }

    // Tab size - affects indentation
    const tabSizeSpaces = " ".repeat(appearanceSettings.tabSize);
    exts.push(indentUnit.of(tabSizeSpaces));
    exts.push(EditorState.tabSize.of(appearanceSettings.tabSize));

    // Add copy extension if filePath is provided
    if (copyExtension) {
      exts.push(copyExtension);
    }

    // Add lazy-loaded language extension
    if (lazyLangExtension) {
      exts.push(lazyLangExtension);
    }

    // Add cursor extension if provided
    if (cursorExtension) {
      exts.push(cursorExtension);
    }

    // Add text selection extension if provided
    if (selectionExtension) {
      exts.push(selectionExtension);
    }

    // Add optional features
    if (enableGoToLine) {
      exts.push(goToLineExtension());
    }

    if (effectiveIndentGuides) {
      exts.push(indentGuidesExtension());
    }

    // Minimap - uses sibling element via ref
    if (effectiveMinimap) {
      exts.push(minimapExtension(minimapHostRef));
    }

    if (enableFindReplace) {
      exts.push(findReplaceExtension());
    }

    // Dirty diff gutter
    if (dirtyDiffExtension) {
      exts.push(dirtyDiffExtension);
    }

    // Git blame inline annotation
    if (gitBlameExt) {
      exts.push(gitBlameExt);
    }

    return exts;
  }, [
    themeExtension,
    copyExtension,
    lazyLangExtension,
    cursorExtension,
    selectionExtension,
    enableGoToLine,
    effectiveIndentGuides,
    effectiveMinimap,
    enableFindReplace,
    dirtyDiffExtension,
    gitBlameExt,
    appearanceSettings.wordWrap,
    appearanceSettings.tabSize,
    appearanceSettings.lineNumbers,
    lineNumberStart,
    minimapHostRef,
  ]);
}
