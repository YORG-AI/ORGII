/**
 * CodeMirrorConflictEditor Component
 *
 * A CodeMirror-based editor for resolving Git merge conflicts.
 * Features:
 * - Syntax highlighting for conflict markers
 * - Visual highlighting of current (ours) vs incoming (theirs) sections
 * - Inline resolution actions (Accept Current / Accept Incoming / Accept Both)
 * - Full editing capability with CodeMirror features
 * - Keyboard navigation between conflicts
 */
import { history } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentUnit } from "@codemirror/language";
import {
  EditorState,
  Extension,
  type Range,
  StateEffect,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CustomScrollbar,
  type ScrollbarMarker,
} from "@src/components/CustomScrollbar";
import { useEditorAppearanceSettings } from "@src/hooks/settings";

import {
  codeMirrorCspNonceExtension,
  createCodeMirrorTheme,
  editorHistoryKeymapExtension,
  getCodeMirrorTheme,
} from "../config";
import { getLanguageExtension } from "../shared/languageExtensions";
import "./index.scss";
import type {
  CodeMirrorConflictEditorProps,
  ConflictBlock,
  ConflictResolutionChoice,
} from "./types";
import { parseConflictBlocks } from "./useConflictMarkers";

// ============================================
// Conflict Actions Widget (CodeMirror Widget)
// ============================================

// Store resolve handlers globally so widgets can access them
const resolveHandlers = new Map<
  string,
  (conflictId: string, choice: ConflictResolutionChoice) => void
>();

class ConflictActionsWidget extends WidgetType {
  constructor(readonly conflictId: string) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "conflict-actions-widget";

    const createLink = (text: string, choice: ConflictResolutionChoice) => {
      const link = document.createElement("span");
      link.className = "conflict-action-link";
      link.textContent = text;
      link.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const handler = resolveHandlers.get("current");
        if (handler) {
          handler(this.conflictId, choice);
        }
      };
      return link;
    };

    const createSeparator = () => {
      const sep = document.createElement("span");
      sep.className = "conflict-action-separator";
      sep.textContent = " | ";
      return sep;
    };

    container.appendChild(createLink("Accept Current Change", "current"));
    container.appendChild(createSeparator());
    container.appendChild(createLink("Accept Incoming Change", "incoming"));
    container.appendChild(createSeparator());
    container.appendChild(createLink("Accept Both Changes", "both"));

    return container;
  }

  eq(other: ConflictActionsWidget): boolean {
    return other.conflictId === this.conflictId;
  }

  ignoreEvent(): boolean {
    return false; // Let CodeMirror handle events normally
  }
}

// ============================================
// Inline Label Widget (at end of marker line)
// ============================================

interface InlineLabelWidgetConfig {
  label: string;
  type: "current" | "incoming";
}

class InlineLabelWidget extends WidgetType {
  constructor(private config: InlineLabelWidgetConfig) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `conflict-inline-label conflict-inline-label--${this.config.type}`;
    span.textContent = this.config.label;
    return span;
  }

  eq(other: InlineLabelWidget): boolean {
    return (
      this.config.label === other.config.label &&
      this.config.type === other.config.type
    );
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ============================================
// Conflict Decorations
// ============================================

// Line decoration classes
const currentLineDecoration = Decoration.line({
  class: "cm-conflict-current-line",
});

const incomingLineDecoration = Decoration.line({
  class: "cm-conflict-incoming-line",
});

const startMarkerLineDecoration = Decoration.line({
  class: "cm-conflict-start-marker-line",
});

const endMarkerLineDecoration = Decoration.line({
  class: "cm-conflict-end-marker-line",
});

const separatorLineDecoration = Decoration.line({
  class: "cm-conflict-separator-line",
});

// Create decorations for conflicts (line highlighting only, action bar is React overlay)
function createConflictDecorations(
  view: EditorView,
  conflicts: ConflictBlock[]
): DecorationSet {
  const builder: Range<Decoration>[] = [];
  const doc = view.state.doc;

  for (const conflict of conflicts) {
    // Ensure line numbers are within bounds
    if (conflict.endLine >= doc.lines) continue;

    const startLineInfo = doc.line(conflict.markerStartLine + 1);

    // Action bar widget ABOVE the <<<<<<< line
    builder.push(
      Decoration.widget({
        widget: new ConflictActionsWidget(conflict.id),
        block: true,
        side: -1, // Before the line
      }).range(startLineInfo.from)
    );

    // Highlight <<<<<<< marker line (green background like current)
    builder.push(startMarkerLineDecoration.range(startLineInfo.from));

    // Inline label "(Current Change)" at end of <<<<<<< line
    builder.push(
      Decoration.widget({
        widget: new InlineLabelWidget({
          label: "(Current Change)",
          type: "current",
        }),
        side: 1, // After the line content
      }).range(startLineInfo.to)
    );

    // Highlight current (ours) content lines
    for (
      let lineNum = conflict.markerStartLine + 2;
      lineNum <= conflict.separatorLine;
      lineNum++
    ) {
      if (lineNum > doc.lines) break;
      const lineInfo = doc.line(lineNum);
      builder.push(currentLineDecoration.range(lineInfo.from));
    }

    // Highlight separator line
    if (conflict.separatorLine + 1 <= doc.lines) {
      const sepLineInfo = doc.line(conflict.separatorLine + 1);
      builder.push(separatorLineDecoration.range(sepLineInfo.from));
    }

    // Highlight incoming (theirs) content lines
    for (
      let lineNum = conflict.separatorLine + 2;
      lineNum <= conflict.markerEndLine;
      lineNum++
    ) {
      if (lineNum > doc.lines) break;
      const lineInfo = doc.line(lineNum);
      builder.push(incomingLineDecoration.range(lineInfo.from));
    }

    // Highlight >>>>>>> marker line (blue background like incoming)
    if (conflict.markerEndLine + 1 <= doc.lines) {
      const endLineInfo = doc.line(conflict.markerEndLine + 1);
      builder.push(endMarkerLineDecoration.range(endLineInfo.from));

      // Inline label "(Incoming Change)" at end of >>>>>>> line
      builder.push(
        Decoration.widget({
          widget: new InlineLabelWidget({
            label: "(Incoming Change)",
            type: "incoming",
          }),
          side: 1,
        }).range(endLineInfo.to)
      );
    }
  }

  // Use Decoration.set with `true` to let CodeMirror sort automatically
  // This handles both `from` position and `startSide` sorting
  return Decoration.set(builder, true);
}

// ============================================
// Main Component
// ============================================

export const CodeMirrorConflictEditor: React.FC<
  CodeMirrorConflictEditorProps
> = ({
  content,
  filePath,
  language,
  readOnly = false,
  onChange,
  onResolveConflict,
  height = "100%",
  className = "",
  focusedConflictIndex = 0,
  onFocusConflictChange: _onFocusConflictChange,
}) => {
  const appearanceSettings = useEditorAppearanceSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onResolveRef = useRef(onResolveConflict);
  const onChangeRef = useRef(onChange);
  const [totalLines, setTotalLines] = useState(0);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  // Keep refs updated
  useEffect(() => {
    onResolveRef.current = onResolveConflict;
    onChangeRef.current = onChange;
  }, [onResolveConflict, onChange]);

  // Parse conflicts
  const conflicts = useMemo(() => parseConflictBlocks(content), [content]);

  // Scroll to a specific line when marker is clicked
  const handleMarkerClick = useCallback((lineNumber: number) => {
    if (!viewRef.current) return;
    const doc = viewRef.current.state.doc;
    if (lineNumber + 1 <= doc.lines) {
      const lineInfo = doc.line(lineNumber + 1);
      viewRef.current.dispatch({
        effects: EditorView.scrollIntoView(lineInfo.from, {
          y: "start",
        }),
      });
    }
  }, []);

  // Handle conflict resolution - uses CodeMirror transaction for undo support
  const handleResolve = useCallback(
    (conflictId: string, choice: ConflictResolutionChoice) => {
      const conflict = conflicts.find(
        (conflictItem) => conflictItem.id === conflictId
      );
      if (!conflict || !viewRef.current) return;

      const view = viewRef.current;
      const doc = view.state.doc;

      // Calculate the start and end positions in the document
      // Lines are 1-indexed in CodeMirror
      const startLine = doc.line(conflict.markerStartLine + 1);
      const endLine = doc.line(conflict.markerEndLine + 1);

      // Determine replacement text based on choice
      let replacementText = "";
      if (choice === "current") {
        replacementText = conflict.currentContent;
      } else if (choice === "incoming") {
        replacementText = conflict.incomingContent;
      } else if (choice === "both") {
        replacementText =
          conflict.currentContent + "\n" + conflict.incomingContent;
      }

      // Use CodeMirror's dispatch to update - this supports undo/redo
      view.dispatch({
        changes: {
          from: startLine.from,
          to: endLine.to,
          insert: replacementText,
        },
        // Mark this as a user action for proper undo grouping
        userEvent: "input.resolve-conflict",
      });

      // Notify parent about the resolution
      onResolveRef.current?.(conflictId, choice);
    },
    [conflicts]
  );

  // Register the resolve handler so widgets can access it
  useEffect(() => {
    resolveHandlers.set("current", handleResolve);
    return () => {
      resolveHandlers.delete("current");
    };
  }, [handleResolve]);

  // Create/update editor
  useEffect(() => {
    if (!editorContainerRef.current) return;

    // Clean up existing view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    // Clear container
    editorContainerRef.current.innerHTML = "";

    // Build extensions
    const extensions: Extension[] = [codeMirrorCspNonceExtension];

    extensions.push(getCodeMirrorTheme());

    // Line numbers based on appearance settings
    if (appearanceSettings.lineNumbers === "on") {
      extensions.push(lineNumbers());
    } else if (appearanceSettings.lineNumbers === "relative") {
      extensions.push(
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
      extensions.push(
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
    // "off" = no lineNumbers extension added

    // Highlight active line (based on settings)
    if (appearanceSettings.highlightActiveLine) {
      extensions.push(highlightActiveLineGutter());
      extensions.push(highlightActiveLine());
    }

    // Fold gutter and bracket matching
    extensions.push(foldGutter());
    extensions.push(bracketMatching());
    extensions.push(createCodeMirrorTheme());

    // Word wrap
    if (appearanceSettings.wordWrap) {
      extensions.push(EditorView.lineWrapping);
    }

    // Tab size
    const tabSizeSpaces = " ".repeat(appearanceSettings.tabSize);
    extensions.push(indentUnit.of(tabSizeSpaces));
    extensions.push(EditorState.tabSize.of(appearanceSettings.tabSize));

    // History (undo/redo) support
    extensions.push(history());
    extensions.push(editorHistoryKeymapExtension());

    // Language extension
    const langExt = getLanguageExtension(filePath, language);
    if (langExt) {
      extensions.push(langExt);
    }

    // Read-only mode
    extensions.push(EditorView.editable.of(!readOnly));

    // Update listener for content changes
    extensions.push(
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged && onChangeRef.current) {
          onChangeRef.current(update.state.doc.toString());
        }
      })
    );

    // Create view
    const view = new EditorView({
      doc: content,
      extensions,
      parent: editorContainerRef.current,
    });

    viewRef.current = view;
    setEditorView(view);

    // Update total lines for scrollbar markers
    setTotalLines(view.state.doc.lines);

    // Add conflict decorations after view is created
    const decorations = createConflictDecorations(view, conflicts);
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        EditorView.decorations.of(decorations)
      ),
    });

    return () => {
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [
    content,
    filePath,
    language,
    readOnly,
    conflicts,
    appearanceSettings.lineNumbers,
    appearanceSettings.highlightActiveLine,
    appearanceSettings.wordWrap,
    appearanceSettings.tabSize,
  ]);

  // Scroll to focused conflict
  useEffect(() => {
    if (!viewRef.current || conflicts.length === 0) return;
    if (focusedConflictIndex < 0 || focusedConflictIndex >= conflicts.length)
      return;

    const conflict = conflicts[focusedConflictIndex];
    const doc = viewRef.current.state.doc;

    if (conflict.markerStartLine + 1 <= doc.lines) {
      const lineInfo = doc.line(conflict.markerStartLine + 1);
      viewRef.current.dispatch({
        effects: EditorView.scrollIntoView(lineInfo.from, {
          y: "center",
        }),
      });
    }
  }, [focusedConflictIndex, conflicts]);

  // Convert conflicts to scrollbar markers
  const scrollbarMarkers: ScrollbarMarker[] = useMemo(
    () =>
      conflicts.map((conflict) => ({
        id: conflict.id,
        line: conflict.markerStartLine,
        lineCount: conflict.markerEndLine - conflict.markerStartLine + 1,
        color: "rgba(255, 165, 0, 0.9)", // Orange for conflicts
        tooltip: `Conflict: ${conflict.currentLabel} vs ${conflict.incomingLabel}`,
        onClick: () => handleMarkerClick(conflict.markerStartLine),
      })),
    [conflicts, handleMarkerClick]
  );

  return (
    <div
      ref={containerRef}
      className={`codemirror-conflict-editor-wrapper ${className}`}
      style={{ height }}
    >
      <div ref={editorContainerRef} className="codemirror-conflict-editor" />

      <CustomScrollbar
        scrollElement={editorView?.scrollDOM || null}
        totalLines={totalLines}
        markers={scrollbarMarkers}
        onScrollToLine={handleMarkerClick}
      />
    </div>
  );
};

CodeMirrorConflictEditor.displayName = "CodeMirrorConflictEditor";

// Export types and utilities
export * from "./types";
export { hasConflictMarkers } from "./useConflictMarkers";
export default CodeMirrorConflictEditor;
