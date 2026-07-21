/**
 * CodeMirrorDiff Component
 *
 * A wrapper around CodeMirror 6's merge view for displaying diffs.
 * Supports both unified (inline) and split (side-by-side) views.
 *
 * Features:
 * - Unified diff view
 * - Split diff view
 * - Native CodeMirror syntax highlighting via Lezer parsers
 * - Accept/reject changes
 * - Collapse unchanged regions
 *
 * Performance: only the active view mode is constructed. Switching modes
 * destroys the previous editor before creating the requested one.
 */
import { history } from "@codemirror/commands";
import { bracketMatching, indentUnit } from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, Extension, StateEffect } from "@codemirror/state";
import {
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import { EditorView } from "codemirror";
import React, { useEffect, useRef, useState } from "react";

import { CustomScrollbar } from "@src/components/CustomScrollbar";
import type { GitFileStatus } from "@src/config/gitStatus";
import { createLogger } from "@src/hooks/logger";
import { useEditorAppearanceSettings } from "@src/hooks/settings";
import { EditorService } from "@src/services/workStation/EditorService";

import { useSelectionExtension } from "../Editor/hooks/useSelectionExtension";
import type { TextSelectionInfo } from "../Editor/types";
import type { CallbackRefs } from "../Editor/types";
import {
  CODEMIRROR_BASE_LAYOUT_THEME,
  codeMirrorCspNonceExtension,
  customFoldGutter,
  editorHistoryKeymapExtension,
  findReplaceExtension,
  foldPlaceholderTheme,
  getCodeMirrorTheme,
  goToLineExtension,
} from "../config";
import { createCopyFileRefExtension } from "../shared/createCopyFileRefExtension";
import { getLanguageExtension } from "../shared/languageExtensions";
import "./index.scss";

const log = createLogger("CodeMirrorDiff");

// ============================================
// Types
// ============================================

export interface CodeMirrorDiffProps {
  /** Original content */
  oldValue: string;
  /** Modified content */
  newValue: string;
  /** File path for language detection */
  filePath?: string;
  /** Programming language */
  language?: string;
  /** Container height */
  height?: string;
  /** Diff view mode: unified (inline) or split (side-by-side) */
  viewMode?: "unified" | "split";
  /** Read-only mode */
  readOnly?: boolean;
  /** Show merge controls (accept/reject buttons) */
  mergeControls?: boolean;
  /** Collapse unchanged regions */
  collapseUnchanged?: boolean;
  /** Callback when content changes */
  onChange?: (value: string) => void;
  /** Callback when text is selected. */
  onTextSelection?: (selection: TextSelectionInfo | null) => void;
  /** Let the editor grow to its content height instead of scrolling internally. */
  autoHeight?: boolean;
  /** Explicit git status when content alone is not enough to infer diff direction. */
  changeType?: GitFileStatus;
  /** Starting line number for old/original content when rendering a diff hunk. */
  oldStartLine?: number;
  /** Starting line number for new/modified content when rendering a diff hunk. */
  newStartLine?: number;
  /** Show editor gutter line numbers. */
  showLineNumbers?: boolean;
  /** Custom class name */
  className?: string;
  /**
   * When true, suppresses the bottom padding on the split-view scroll container
   * (for contexts without a bottom panel, e.g. agent station diff, source control).
   */
  noBottomPadding?: boolean;
}

// ============================================
// Shared merge theme override (stable reference — defined outside component)
// ============================================

const MERGE_THEME_OVERRIDE = EditorView.baseTheme({
  "& .cm-changedLine, & .cm-insertedLine": {
    backgroundColor: "var(--diff-added-bg) !important",
  },
  "&.cm-merge-a .cm-changedLine, & .cm-deletedLine": {
    backgroundColor: "var(--diff-deleted-bg) !important",
  },
  "& .cm-insertedChunk, & .cm-insertedText": {
    backgroundColor: "var(--diff-added-bg) !important",
  },
  "& .cm-deletedChunk, & .cm-deletedText": {
    backgroundColor: "var(--diff-deleted-bg) !important",
  },
  ".cm-collapsedLines": {
    display: "flex",
    alignItems: "center",
    gap: "var(--cm-gutter-padding, 4px)",
    width: "100%",
    background: "var(--color-fill-1)",
    border: "none",
    borderRadius: "0",
    outline: "none",
    boxShadow: "none",
    color: "var(--color-text-3)",
    padding: "var(--cm-gutter-padding, 4px) var(--cm-line-padding-left, 12px)",
    margin: "0",
    cursor: "pointer",
    fontSize: "var(--cm-font-size-small, 12px)",
    "&::before": {
      content: '""',
      display: "inline-block",
      width: "var(--cm-icon-size, 14px)",
      height: "var(--cm-icon-size, 14px)",
      marginInlineEnd: "0",
      backgroundColor: "currentColor",
      maskImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E")`,
      maskSize: "contain",
      maskRepeat: "no-repeat",
      maskPosition: "center",
      WebkitMaskImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m7 15 5 5 5-5'/%3E%3Cpath d='m7 9 5-5 5 5'/%3E%3C/svg%3E")`,
      WebkitMaskSize: "contain",
      WebkitMaskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      flexShrink: 0,
    },
    "&::after": {
      content: '""',
      display: "none",
    },
    "&:hover": {
      background: "var(--color-fill-3)",
      color: "var(--color-text-2)",
    },
  },
});

const AUTO_HEIGHT_THEME = EditorView.theme({
  "&": {
    height: "auto",
  },
  ".cm-scroller": {
    overflow: "visible",
  },
});

// ============================================
// Main Component
// ============================================

export const CodeMirrorDiff: React.FC<CodeMirrorDiffProps> = ({
  oldValue,
  newValue,
  filePath,
  language,
  height = "100%",
  viewMode = "unified",
  readOnly = true,
  mergeControls = true,
  collapseUnchanged = true,
  onChange,
  onTextSelection,
  autoHeight = false,
  changeType,
  oldStartLine = 1,
  newStartLine = 1,
  showLineNumbers = true,
  className = "",
  noBottomPadding = false,
}) => {
  const appearanceSettings = useEditorAppearanceSettings();
  const isFullDeletion =
    changeType === "deleted" || (oldValue.length > 0 && newValue.length === 0);
  const unifiedDocumentValue = isFullDeletion ? "" : newValue;
  const unifiedOriginalValue = oldValue;

  // Separate refs are retained for each implementation, but only the active
  // mode has a mounted DOM container or live editor instance.
  const unifiedContainerRef = useRef<HTMLDivElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Live editor instances
  const unifiedViewRef = useRef<EditorView | null>(null);
  const splitMergeViewRef = useRef<MergeView | null>(null);

  // Scrollbar wiring
  const [unifiedScrollEl, setUnifiedScrollEl] = useState<HTMLElement | null>(
    null
  );
  const [splitScrollEl, setSplitScrollEl] = useState<HTMLElement | null>(null);
  const [unifiedLines, setUnifiedLines] = useState(0);
  const [splitLines, setSplitLines] = useState(0);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const callbackRefs = useRef<CallbackRefs>({});
  useEffect(() => {
    callbackRefs.current = {
      onTextSelection,
      filePath,
    };
  });
  const selectionExtension = useSelectionExtension(
    callbackRefs,
    !!onTextSelection
  );

  // Track the content that each live instance was last built with,
  // so we can dispatch updates without a full rebuild.
  const unifiedContentRef = useRef<{
    old: string;
    new: string;
    changeType?: GitFileStatus;
    startLine: number;
    showLineNumbers: boolean;
  } | null>(null);
  const splitContentRef = useRef<{
    old: string;
    new: string;
    oldStartLine: number;
    newStartLine: number;
    showLineNumbers: boolean;
  } | null>(null);

  // ── Stable base extensions (rebuilt only when theme/settings change) ─────

  const buildBaseExtensions = (lineNumberStart = 1): Extension[] => {
    const lineNumberOffset = Math.max(1, lineNumberStart) - 1;
    const formatAbsoluteLineNumber = (lineNo: number) =>
      String(lineNo + lineNumberOffset);
    const exts: Extension[] = [codeMirrorCspNonceExtension];

    exts.push(getCodeMirrorTheme());
    exts.push(CODEMIRROR_BASE_LAYOUT_THEME);

    if (showLineNumbers) {
      if (appearanceSettings.lineNumbers === "on") {
        exts.push(lineNumbers({ formatNumber: formatAbsoluteLineNumber }));
      } else if (appearanceSettings.lineNumbers === "relative") {
        exts.push(
          lineNumbers({
            formatNumber: (lineNo: number, state: EditorState) => {
              const cursorLine = state.doc.lineAt(
                state.selection.main.head
              ).number;
              return lineNo === cursorLine
                ? formatAbsoluteLineNumber(lineNo)
                : String(Math.abs(lineNo - cursorLine));
            },
          })
        );
      } else if (appearanceSettings.lineNumbers === "interval") {
        exts.push(
          lineNumbers({
            formatNumber: (lineNo: number) => {
              const absoluteLineNo = lineNo + lineNumberOffset;
              return absoluteLineNo === 1 || absoluteLineNo % 10 === 0
                ? String(absoluteLineNo)
                : "";
            },
          })
        );
      }
    }

    if (appearanceSettings.highlightActiveLine) {
      exts.push(highlightActiveLineGutter());
      exts.push(highlightActiveLine());
    }

    exts.push(customFoldGutter());
    exts.push(foldPlaceholderTheme());
    if (!readOnly) {
      exts.push(history());
      exts.push(editorHistoryKeymapExtension());
      exts.push(bracketMatching());
    }
    if (appearanceSettings.wordWrap) {
      exts.push(EditorView.lineWrapping);
    }
    exts.push(goToLineExtension());

    if (!readOnly) {
      const tabSizeSpaces = " ".repeat(appearanceSettings.tabSize);
      exts.push(indentUnit.of(tabSizeSpaces));
      exts.push(EditorState.tabSize.of(appearanceSettings.tabSize));
    }

    const langExt = getLanguageExtension(filePath, language);
    if (langExt) exts.push(langExt);

    if (filePath) exts.push(createCopyFileRefExtension(filePath));

    exts.push(findReplaceExtension());
    if (selectionExtension) {
      exts.push(selectionExtension);
    }

    return exts;
  };

  // ── Unified view lifecycle ────────────────────────────────────────────────

  useEffect(() => {
    if (viewMode !== "unified") return;
    if (!unifiedContainerRef.current) return;

    const container = unifiedContainerRef.current;
    container.innerHTML = "";

    try {
      const baseExts = buildBaseExtensions(newStartLine);

      const deletionColorOverride = EditorView.theme({
        "& .cm-changedLine, & .cm-insertedLine": {
          backgroundColor: "var(--diff-deleted-bg) !important",
        },
        "& .cm-insertedChunk, & .cm-deletedChunk": {
          backgroundColor: "var(--diff-deleted-bg) !important",
        },
        "& .cm-changedLineGutter::before": {
          backgroundColor: "var(--diff-deleted-color) !important",
        },
      });

      const view = new EditorView({
        doc: unifiedDocumentValue,
        extensions: [
          ...baseExts,
          MERGE_THEME_OVERRIDE,
          ...(autoHeight ? [AUTO_HEIGHT_THEME] : []),
          ...(isFullDeletion ? [deletionColorOverride] : []),
          unifiedMergeView({
            original: unifiedOriginalValue,
            mergeControls: isFullDeletion ? false : mergeControls,
            highlightChanges: true,
            syntaxHighlightDeletions: true,
            collapseUnchanged: collapseUnchanged
              ? { margin: 3, minSize: 10 }
              : undefined,
          }),
          EditorView.editable.of(isFullDeletion ? false : !readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && onChangeRef.current && !isFullDeletion) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
        parent: container,
      });

      unifiedViewRef.current = view;
      unifiedContentRef.current = {
        old: oldValue,
        new: newValue,
        changeType,
        startLine: newStartLine,
        showLineNumbers,
      };
      setUnifiedScrollEl(view.scrollDOM);
      setUnifiedLines(view.state.doc.lines);
      EditorService.setEditorView(view);
    } catch (err) {
      log.error("[CodeMirrorDiff] Error creating unified view:", err);
    }

    return () => {
      const view = unifiedViewRef.current;
      if (view && EditorService.getEditorView() === view) {
        EditorService.clearEditorView();
      }
      view?.destroy();
      unifiedViewRef.current = null;
      unifiedContentRef.current = null;
    };
    // `unifiedMergeView` binds the original side at construction. Modified
    // content is updated by the effect below without destroying the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewMode,
    oldValue,
    changeType,
    isFullDeletion,
    newStartLine,
    showLineNumbers,
    readOnly,
    mergeControls,
    collapseUnchanged,
    autoHeight,
    filePath,
    language,
    appearanceSettings.lineNumbers,
    appearanceSettings.highlightActiveLine,
    appearanceSettings.wordWrap,
    appearanceSettings.tabSize,
    selectionExtension,
  ]);

  useEffect(() => {
    if (viewMode !== "unified") return;
    const view = unifiedViewRef.current;
    if (!view || !unifiedContentRef.current) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== unifiedDocumentValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: currentDoc.length,
          insert: unifiedDocumentValue,
        },
      });
    }
    unifiedContentRef.current.new = newValue;
    setUnifiedLines(view.state.doc.lines);
  }, [newValue, unifiedDocumentValue, viewMode]);

  // ── Split view lifecycle ──────────────────────────────────────────────────

  useEffect(() => {
    if (viewMode !== "split") return;
    if (!splitContainerRef.current) return;

    const container = splitContainerRef.current;
    container.innerHTML = "";

    try {
      const oldPaneExts = [
        ...buildBaseExtensions(oldStartLine),
        MERGE_THEME_OVERRIDE,
        ...(autoHeight ? [AUTO_HEIGHT_THEME] : []),
      ];
      const newPaneExts = [
        ...buildBaseExtensions(newStartLine),
        MERGE_THEME_OVERRIDE,
        ...(autoHeight ? [AUTO_HEIGHT_THEME] : []),
      ];

      const mergeView = new MergeView({
        a: { doc: oldValue, extensions: oldPaneExts },
        b: { doc: newValue, extensions: newPaneExts },
        parent: container,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: collapseUnchanged
          ? { margin: 3, minSize: 10 }
          : undefined,
      });

      splitMergeViewRef.current = mergeView;
      splitContentRef.current = {
        old: oldValue,
        new: newValue,
        oldStartLine,
        newStartLine,
        showLineNumbers,
      };
      setSplitScrollEl(splitContainerRef.current);
      setSplitLines(mergeView.b.state.doc.lines);
      EditorService.setEditorView(mergeView.b);

      if (!readOnly) {
        mergeView.b.dispatch({
          effects: [
            StateEffect.appendConfig.of(
              EditorView.updateListener.of((update) => {
                if (update.docChanged && onChangeRef.current) {
                  onChangeRef.current(update.state.doc.toString());
                }
              })
            ),
          ],
        });
      }
    } catch (err) {
      log.error("[CodeMirrorDiff] Error creating split view:", err);
    }

    return () => {
      const mergeView = splitMergeViewRef.current;
      if (mergeView && EditorService.getEditorView() === mergeView.b) {
        EditorService.clearEditorView();
      }
      mergeView?.destroy();
      splitMergeViewRef.current = null;
      splitContentRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewMode,
    oldStartLine,
    newStartLine,
    showLineNumbers,
    readOnly,
    collapseUnchanged,
    autoHeight,
    filePath,
    language,
    appearanceSettings.lineNumbers,
    appearanceSettings.highlightActiveLine,
    appearanceSettings.wordWrap,
    appearanceSettings.tabSize,
    selectionExtension,
  ]);

  useEffect(() => {
    if (viewMode !== "split") return;
    const mergeView = splitMergeViewRef.current;
    if (!mergeView || !splitContentRef.current) return;

    const oldDoc = mergeView.a.state.doc.toString();
    if (oldDoc !== oldValue) {
      mergeView.a.dispatch({
        changes: { from: 0, to: oldDoc.length, insert: oldValue },
      });
    }
    const newDoc = mergeView.b.state.doc.toString();
    if (newDoc !== newValue) {
      mergeView.b.dispatch({
        changes: { from: 0, to: newDoc.length, insert: newValue },
      });
    }
    splitContentRef.current.old = oldValue;
    splitContentRef.current.new = newValue;
    setSplitLines(mergeView.b.state.doc.lines);
  }, [newValue, oldValue, viewMode]);

  // ── Render ────────────────────────────────────────────────────────────────

  const isUnifiedFullDeletion = isFullDeletion;
  const wrapperStyle: React.CSSProperties = autoHeight
    ? { position: "relative" }
    : { height, position: "relative" };
  const visiblePaneStyle: React.CSSProperties = autoHeight
    ? { position: "relative" }
    : { position: "absolute", inset: 0 };
  return (
    <div
      className={`codemirror-diff-wrapper ${autoHeight ? "codemirror-diff-wrapper--auto-height" : ""} ${isUnifiedFullDeletion ? "codemirror-diff-wrapper--full-deletion" : ""} ${className}`}
      style={wrapperStyle}
    >
      {viewMode === "unified" ? (
        <div
          ref={unifiedContainerRef}
          className="codemirror-diff codemirror-diff--unified"
          spellCheck={false}
          style={visiblePaneStyle}
        />
      ) : (
        <div
          ref={splitContainerRef}
          className={`codemirror-diff codemirror-diff--split${noBottomPadding ? "codemirror-diff--no-bottom-padding" : ""}`}
          spellCheck={false}
          style={visiblePaneStyle}
        />
      )}
      {!autoHeight && (
        <CustomScrollbar
          scrollElement={
            viewMode === "unified" ? unifiedScrollEl : splitScrollEl
          }
          totalLines={viewMode === "unified" ? unifiedLines : splitLines}
        />
      )}
    </div>
  );
};

CodeMirrorDiff.displayName = "CodeMirrorDiff";

export default CodeMirrorDiff;
