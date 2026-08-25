/**
 * CodeMirrorEditor Types
 *
 * Type definitions for the CodeMirror editor component.
 */

// ============================================
// Public Types (exported to consumers)
// ============================================

export interface CursorPosition {
  /** Current line number (1-based) */
  line: number;
  /** Current column number (1-based) */
  column: number;
  /** Number of characters selected */
  selectedChars?: number;
  /** Number of lines selected */
  selectedLines?: number;
}

export interface TextSelectionInfo {
  /** Selected text */
  text: string;
  /** Start line (1-based) */
  fromLine: number;
  /** End line (1-based) */
  toLine: number;
  /** Mouse position when selection completed */
  position: { x: number; y: number };
}

export interface CodeMirrorEditorProps {
  /** Code content */
  value: string;
  /** Original content for dirty diff (shows gutter markers when different) */
  originalValue?: string;
  /** File path for language detection */
  filePath?: string;
  /** Programming language */
  language?: string;
  /** Container height */
  height?: string;
  /** Read-only mode */
  readOnly?: boolean;
  /** Callback when content changes */
  onChange?: (value: string) => void;
  /** Callback when cursor position changes */
  onCursorChange?: (cursor: CursorPosition) => void;
  /** Callback when text is selected (on mouseup with selection) */
  onTextSelection?: (selection: TextSelectionInfo | null) => void;
  /** Custom class name */
  className?: string;
  /** Enable minimap (default: false) */
  enableMinimap?: boolean;
  /** Enable indent guides (default: true) */
  enableIndentGuides?: boolean;
  /** Enable go to line with Cmd+G (default: true) */
  enableGoToLine?: boolean;
  /** Enable find & replace with Cmd+F/Cmd+H (default: true) */
  enableFindReplace?: boolean;
  /** Enable dirty diff gutter (default: true when originalValue provided) */
  enableDirtyDiff?: boolean;
  /** Whether the file has been deleted (shows all lines as deleted markers) */
  isDeletedFile?: boolean;
  /** Register with EditorService (default: true) */
  registerWithService?: boolean;
  /** Enable inline git blame annotation on current line */
  enableGitBlame?: boolean;
  /** Repo root path (for computing relative file path for blame) */
  repoPath?: string;
  /**
   * 1-indexed file line of the first document line (default: 1). Used by
   * read-only viewers showing a ranged file excerpt so the gutter displays
   * real file line numbers instead of restarting at 1.
   */
  lineNumberStart?: number;
}

// ============================================
// Internal Types (used by hooks)
// ============================================

export interface CallbackRefs {
  onCursorChange?: (cursor: CursorPosition) => void;
  onTextSelection?: (selection: TextSelectionInfo | null) => void;
  onChange?: (value: string) => void;
  filePath?: string;
}
