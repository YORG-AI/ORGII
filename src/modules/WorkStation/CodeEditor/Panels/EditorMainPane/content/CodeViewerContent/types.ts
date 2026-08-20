/**
 * Types for CodeViewerContent component
 */
import type {
  ConflictResolutionChoice,
  CursorPosition,
} from "@src/features/CodeMirror";
import type { FileError } from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";

import type { Diagnostic } from "../../../EditorBottomPanel/content/ProblemsContent/types";

// ============================================
// Main Component Props
// ============================================

export interface CodeViewerContentProps {
  /** Selected file path */
  selectedFile: string | null;
  /** File content to display */
  fileContent: string;
  /** Loading state */
  loading: boolean;
  /** Typed error */
  error: FileError | null;
  /** Repository path (for relative path calculation) */
  repoPath: string;
  /** Callback when a file is selected from breadcrumb */
  onFileSelect?: (filePath: string) => void;
  /** Callback when content changes */
  onContentChange?: (content: string) => void;
  /** Callback when save is requested */
  onSave?: () => Promise<void>;
  /** Callback when discard is requested */
  onDiscard?: () => void;
  /** Callback when reload is requested */
  onReload?: () => Promise<void>;
  /** Has unsaved changes */
  hasUnsavedChanges?: boolean;
  /** Saving state */
  saving?: boolean;
  /** Callback when diagnostics change */
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void;
  /** Callback when cursor position changes */
  onCursorPositionChange?: (position: CursorPosition | null) => void;
  /** Whether the file should route through a dedicated preview instead of CodeMirror */
  requiresFilePreviewRoute?: boolean;
  /** Initial raw/preview toggle state when this file becomes selected. */
  defaultPreviewMode?: boolean;
  /** Read-only mode - no editing, no save/discard (for git logs, previews) */
  readOnly?: boolean;
  /** Whether content is ready for the current file (prevents flashing during file switch) */
  contentReady?: boolean;
  /** Git base content (HEAD version) for showing uncommitted changes */
  gitBaseContent?: string;
  /** Saved-on-disk content for showing unsaved local changes (when file not in git status) */
  savedContent?: string;
  /** Whether the file has been deleted (shows all lines as deleted, read-only) */
  isDeletedFile?: boolean;
  /** Callback after binary preview editors save directly to disk */
  onSaveSuccess?: () => void;
  /** Callback when preview editors have local unsaved changes */
  onBinaryUnsavedChange?: (hasUnsavedChanges: boolean) => void;
}

// ============================================
// Callback Refs Type
// ============================================

export interface CallbackRefs {
  onFileSelect?: (filePath: string) => void;
  onContentChange?: (content: string) => void;
  onSave?: () => Promise<void>;
  onDiscard?: () => void;
  onReload?: () => Promise<void>;
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void;
  onCursorPositionChange?: (position: CursorPosition | null) => void;
}

// ============================================
// Selection Dropdown State
// ============================================

export interface SelectionDropdownState {
  visible: boolean;
  position: { x: number; y: number };
  text: string;
  fromLine: number;
  toLine: number;
}

// ============================================
// View Component Props
// ============================================

export interface FileHeaderProps {
  relativePath: string;
  repoPath: string;
  loading: boolean;
  hasUnsavedChanges: boolean;
  isPreviewable: boolean;
  isPreviewMode: boolean;
  onFileSelect: (filePath: string) => void;
  onReload: () => Promise<void>;
  onTogglePreview: () => void;
}

export interface LoadingViewProps {
  relativePath: string;
  repoPath: string;
  hasUnsavedChanges: boolean;
  isPreviewable: boolean;
  isPreviewMode: boolean;
  saving: boolean;
  onFileSelect: (filePath: string) => void;
  onReload: () => Promise<void>;
  onTogglePreview: () => void;
  onSave: () => Promise<void>;
  onDiscard: () => void;
}

export interface ErrorViewProps {
  relativePath: string;
  repoPath: string;
  selectedFile: string;
  error: FileError;
  hasUnsavedChanges: boolean;
  isPreviewable: boolean;
  isPreviewMode: boolean;
  onFileSelect: (filePath: string) => void;
  onReload: () => Promise<void>;
  onTogglePreview: () => void;
}

export interface BinaryViewProps {
  relativePath: string;
  repoPath: string;
  selectedFile: string;
  fileContent: string;
  previewType: import("@src/util/file/previewTypes").PreviewType;
  readOnly: boolean;
  onFileSelect: (filePath: string) => void;
  onReload: () => Promise<void>;
  onSaveSuccess?: () => void;
  onUnsavedChange?: (hasUnsavedChanges: boolean) => void;
}

export interface ContentViewProps {
  relativePath: string;
  repoPath: string;
  selectedFile: string;
  localContent: string;
  hasUnsavedChanges: boolean;
  isPreviewable: boolean;
  isPreviewMode: boolean;
  isMarkdown: boolean;
  isHtml: boolean;
  isJson: boolean;
  isCsv: boolean;
  fileHasConflicts: boolean;
  readOnly: boolean;
  isDeletedFile: boolean;
  saving: boolean;
  contentReady: boolean;
  gitBaseContent?: string;
  savedContent?: string;
  selectionDropdown: SelectionDropdownState | null;
  onFileSelect: (filePath: string) => void;
  onReload: () => Promise<void>;
  onTogglePreview: () => void;
  onContentChange: (content: string) => void;
  onCursorChange: (cursor: { line: number; column: number }) => void;
  onTextSelection: (
    selection: {
      text: string;
      position: { x: number; y: number };
      fromLine: number;
      toLine: number;
    } | null
  ) => void;
  onDiagnosticsChange: (diagnostics: Diagnostic[]) => void;
  onResolveConflict: (
    conflictId: string,
    choice: ConflictResolutionChoice
  ) => void;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onPreviewSaveSuccess?: () => void;
  onPreviewUnsavedChange?: (hasUnsavedChanges: boolean) => void;
  onAskAgent: (text: string) => void;
  onAddToContext: (text: string, sessionId: string | null) => void;
  onCloseSelectionDropdown: () => void;
}
