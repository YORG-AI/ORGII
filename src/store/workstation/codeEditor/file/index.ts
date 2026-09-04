/**
 * File State Atoms
 *
 * Jotai atoms for file explorer state management.
 * Used by FileService and useCodeEditor hook.
 */
import { atom } from "jotai";

// ============================================
// Types
// ============================================

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  expanded?: boolean;
  gitStatus?: "modified" | "added" | "deleted" | "renamed" | "conflicted";
  gitStaged?: boolean;
  aggregateStatus?: "modified" | "added" | "deleted" | "renamed" | "conflicted";
  /** Whether this is a symbolic link */
  isSymlink?: boolean;
  /** Whether this file is ignored by .gitignore */
  isIgnored?: boolean;
}

export interface FileSearchResult {
  path: string;
  type: "file" | "folder";
  score: number;
  filename: string;
}

// ============================================
// Core State Atoms
// ============================================

/** Currently selected file path */
export const fileSelectedPathAtom = atom<string | null>(null);
fileSelectedPathAtom.debugLabel = "fileSelectedPathAtom";

/** Current file content */
export const fileContentAtom = atom<string>("");
fileContentAtom.debugLabel = "fileContentAtom";

/** Saved content (for dirty detection) */
export const fileSavedContentAtom = atom<string>("");
fileSavedContentAtom.debugLabel = "fileSavedContentAtom";

/** File tree structure */
export const fileTreeAtom = atom<FileNode[]>([]);
fileTreeAtom.debugLabel = "fileTreeAtom";

/** Current repo path */
export const fileRepoPathAtom = atom<string>("");
fileRepoPathAtom.debugLabel = "fileRepoPathAtom";

// ============================================
// Loading States
// ============================================

export const fileLoadingTreeAtom = atom<boolean>(false);
export const fileLoadingContentAtom = atom<boolean>(false);
export const fileSavingAtom = atom<boolean>(false);

// ============================================
// Error States
// ============================================

export const fileTreeErrorAtom = atom<string | null>(null);
export const fileContentErrorAtom = atom<string | null>(null);
export const fileSaveErrorAtom = atom<string | null>(null);

// ============================================
// Derived Atoms
// ============================================

/** Has unsaved changes */
export const fileHasUnsavedChangesAtom = atom((get) => {
  const content = get(fileContentAtom);
  const saved = get(fileSavedContentAtom);
  return content !== saved;
});
fileHasUnsavedChangesAtom.debugLabel = "fileHasUnsavedChangesAtom";

/** Mark file as saved */
export const fileMarkSavedAtom = atom(null, (get, set) => {
  const content = get(fileContentAtom);
  set(fileSavedContentAtom, content);
});

// ============================================
// Search State Atoms
// ============================================

/** Current search query */
export const fileSearchQueryAtom = atom<string>("");
fileSearchQueryAtom.debugLabel = "fileSearchQueryAtom";

/** Search results */
export const fileSearchResultsAtom = atom<FileSearchResult[]>([]);
fileSearchResultsAtom.debugLabel = "fileSearchResultsAtom";

/** Search loading state */
export const fileSearchLoadingAtom = atom<boolean>(false);
fileSearchLoadingAtom.debugLabel = "fileSearchLoadingAtom";

/** Search error */
export const fileSearchErrorAtom = atom<string | null>(null);
fileSearchErrorAtom.debugLabel = "fileSearchErrorAtom";

// ============================================
// Binary Detection
// ============================================

/** Is current file binary */
export const fileIsBinaryAtom = atom<boolean>(false);
fileIsBinaryAtom.debugLabel = "fileIsBinaryAtom";

// ============================================
// Search Action Atoms
// ============================================

/** Clear search */
export const fileClearSearchAtom = atom(null, (_get, set) => {
  set(fileSearchQueryAtom, "");
  set(fileSearchResultsAtom, []);
  set(fileSearchErrorAtom, null);
});

// ============================================
// Re-exports
// ============================================

export { fileClipboardAtom, type FileClipboard } from "./clipboardAtom";
