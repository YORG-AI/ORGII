/**
 * SearchEditorDocument Component
 *
 * A CodeMirror-based editor for displaying search results.
 * All results are serialized into a single document with:
 * - Match highlighting via decorations
 * - File path click navigation (clicking file paths navigates to file)
 * - Editable content
 *
 * This approach (single editor, many decorations) is much more performant
 * than creating separate editors for each match.
 */
import { Extension, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

// Import CodeMirror editor styles for proper scrolling
import "@src/features/CodeMirror/Editor/index.scss";
import {
  BASIC_SETUP_CONFIG,
  codeMirrorCspNonceExtension,
  createCodeMirrorTheme,
  editorHistoryKeymapExtension,
  findReplaceExtension,
  getCodeMirrorTheme,
} from "@src/features/CodeMirror/config";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import type { FilePathRange, MatchRange } from "./serialization";

// ============================================
// Types
// ============================================

export interface SearchEditorDocumentProps {
  /** Serialized search results text */
  content: string;
  /** Match ranges for highlighting */
  matchRanges: MatchRange[];
  /** File path ranges for navigation */
  filePathRanges: FilePathRange[];
  /** Callback when a file path is clicked (navigates to file) */
  onFilePathClick?: (filePath: string, line: number) => void;
  /** Callback when content changes (editable) */
  onChange?: (content: string) => void;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Loading state */
  loading?: boolean;
}

// ============================================
// Decoration Styles
// ============================================

// Match highlight decoration - yellow background like VS Code search
const matchDecoration = Decoration.mark({
  class: "cm-search-match",
});

// File path line decoration - make it stand out
const filePathLineDecoration = Decoration.line({
  class: "cm-search-file-path",
});

// Header line decoration (# Query:, # Flags:, etc.)
const headerLineDecoration = Decoration.line({
  class: "cm-search-header",
});

// Summary line decoration (X results in Y files)
const summaryLineDecoration = Decoration.line({
  class: "cm-search-summary",
});

// ============================================
// File Path Click Handler Extension
// ============================================

/**
 * Create a click handler extension that navigates when clicking file path lines
 * Only file paths trigger navigation, not match lines
 */
function createFilePathClickExtension(
  filePathRanges: FilePathRange[],
  onFilePathClickRef: React.RefObject<
    ((filePath: string, line: number) => void) | undefined
  >
): Extension {
  return EditorView.domEventHandlers({
    click: (event, view) => {
      // Get the position from the click
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      // Get the line number (1-indexed)
      const line = view.state.doc.lineAt(pos);
      const docLine = line.number;

      // Only check file path lines (not match lines)
      const filePathRange = filePathRanges.find((fp) => fp.docLine === docLine);
      if (filePathRange) {
        event.preventDefault();
        // Access ref.current in event handler (not during render)
        onFilePathClickRef.current?.(
          filePathRange.filePath,
          filePathRange.firstMatchLine
        );
        return true;
      }

      return false;
    },
  });
}

// ============================================
// Decoration Extension
// ============================================

/**
 * Create decorations for matches and file paths
 */
function createSearchDecorations(
  view: EditorView,
  matchRanges: MatchRange[],
  filePathRanges: FilePathRange[]
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  // Collect all decorations with their positions for sorting
  const decorations: Array<{
    from: number;
    to: number;
    decoration: Decoration;
  }> = [];

  // Add file path line decorations
  for (const fileRange of filePathRanges) {
    if (fileRange.docLine <= doc.lines) {
      const lineInfo = doc.line(fileRange.docLine);
      decorations.push({
        from: lineInfo.from,
        to: lineInfo.from,
        decoration: filePathLineDecoration,
      });
    }
  }

  // Add match highlight decorations
  for (const matchRange of matchRanges) {
    if (matchRange.docLine <= doc.lines) {
      const lineInfo = doc.line(matchRange.docLine);
      const lineText = lineInfo.text;

      // Calculate absolute positions
      const startOffset = matchRange.startColumn - 1; // Convert to 0-indexed
      const endOffset = matchRange.endColumn - 1;

      // Ensure we don't exceed line bounds
      if (
        startOffset >= 0 &&
        endOffset <= lineText.length &&
        startOffset < endOffset
      ) {
        const from = lineInfo.from + startOffset;
        const to = lineInfo.from + endOffset;
        decorations.push({
          from,
          to,
          decoration: matchDecoration,
        });
      }
    }
  }

  // Add header line decorations (lines starting with #)
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const lineInfo = doc.line(lineNum);
    const text = lineInfo.text;

    if (text.startsWith("# ")) {
      decorations.push({
        from: lineInfo.from,
        to: lineInfo.from,
        decoration: headerLineDecoration,
      });
    } else if (text.match(/^\d+ results? in \d+ files?$/)) {
      decorations.push({
        from: lineInfo.from,
        to: lineInfo.from,
        decoration: summaryLineDecoration,
      });
    }
  }

  // Sort decorations by position (required by CodeMirror)
  decorations.sort((a, b) => a.from - b.from || a.to - b.to);

  // Add to builder
  for (const dec of decorations) {
    builder.add(dec.from, dec.to, dec.decoration);
  }

  return builder.finish();
}

/**
 * View plugin that manages search result decorations
 */
function createSearchDecorationsPlugin(
  matchRanges: MatchRange[],
  filePathRanges: FilePathRange[]
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = createSearchDecorations(
          view,
          matchRanges,
          filePathRanges
        );
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = createSearchDecorations(
            update.view,
            matchRanges,
            filePathRanges
          );
        }
      }
    },
    {
      decorations: (view) => view.decorations,
    }
  );
}

// ============================================
// Theme Extension
// ============================================

const searchEditorTheme = EditorView.theme({
  // Match highlight - yellow background
  ".cm-search-match": {
    backgroundColor: "rgba(234, 179, 8, 0.3)", // warning-6 with opacity
    borderRadius: "2px",
  },
  // File path line - bold, primary color, clickable
  ".cm-search-file-path": {
    fontWeight: "600",
    color: "var(--color-primary-6)",
    cursor: "var(--interactive-cursor, default)",
    "&:hover": {
      textDecoration: "underline",
    },
  },
  // Header lines - dimmed
  ".cm-search-header": {
    color: "var(--color-text-3)",
    fontStyle: "italic",
  },
  // Summary line
  ".cm-search-summary": {
    color: "var(--color-text-2)",
  },
});

// ============================================
// Main Component
// ============================================

export const SearchEditorDocument: React.FC<SearchEditorDocumentProps> = memo(
  ({
    content,
    matchRanges,
    filePathRanges,
    onFilePathClick,
    onChange,
    readOnly = false,
    loading = false,
  }) => {
    const { t } = useTranslation();
    useCurrentTheme();
    const filePathClickRef = useRef(onFilePathClick);

    // Keep ref updated
    useEffect(() => {
      filePathClickRef.current = onFilePathClick;
    }, [onFilePathClick]);

    // Theme — passed via `theme` prop (same pattern as CodeMirrorEditor)
    const theme = getCodeMirrorTheme();

    // Build extensions (color theme goes through `theme` prop; font/spacing via extension)
    const extensions = useMemo(() => {
      const exts: Extension[] = [
        codeMirrorCspNonceExtension,
        editorHistoryKeymapExtension(),
        // Font, spacing, and layout (same as other CM instances)
        createCodeMirrorTheme(),
        // Search-specific decorations
        searchEditorTheme,
        // Decorations for matches and file paths
        createSearchDecorationsPlugin(matchRanges, filePathRanges),
        // File path click handler (only for file path lines)
        // Pass ref directly - it's accessed in event handler, not during render
        // eslint-disable-next-line react-hooks/refs -- ref.current is only read in click handler, not during render
        createFilePathClickExtension(filePathRanges, filePathClickRef),
        // Find & replace (Cmd+F / Cmd+H)
        findReplaceExtension(),
      ];

      // Read-only mode
      if (readOnly) {
        exts.push(EditorView.editable.of(false));
      }

      return exts;
    }, [matchRanges, filePathRanges, readOnly]);

    // Handle content changes
    const handleChange = useCallback(
      (value: string) => {
        onChange?.(value);
      },
      [onChange]
    );

    // Loading state
    if (loading) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("status.searching")}
          fillParentHeight
        />
      );
    }

    // Empty state
    if (!content) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.enterSearchQueryToBegin")}
          fillParentHeight
        />
      );
    }

    // Use exact same wrapper structure as CodeMirrorEditor
    return (
      <div className="codemirror-editor-wrapper">
        <div className="codemirror-editor">
          <CodeMirror
            value={content}
            height="100%"
            style={{ height: "100%", flex: 1, minHeight: 0 }}
            theme={theme}
            extensions={extensions}
            onChange={onChange ? handleChange : undefined}
            basicSetup={BASIC_SETUP_CONFIG}
          />
        </div>
      </div>
    );
  }
);

SearchEditorDocument.displayName = "SearchEditorDocument";

export default SearchEditorDocument;
