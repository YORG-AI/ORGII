import type { EditOperation, EditSource } from "@src/types/editor/document";

export type FileError =
  | { type: "not_found"; message: string }
  | { type: "permission"; message: string }
  | { type: "too_large"; size: number; message: string }
  | { type: "binary"; message: string }
  | { type: "unknown"; message: string };

export interface UseFileContentOptions {
  filePath: string | null;
  autoLoad?: boolean;
}

export interface UseFileContentReturn {
  content: string;
  originalContent: string;
  loading: boolean;
  error: FileError | null;
  isBinary: boolean;
  hasUnsavedChanges: boolean;
  contentReady: boolean;
  version: number;
  diskVersion: number;
  diskMtime: number | null;
  recentEdits: EditOperation[];
  getAIEdits: () => EditOperation[];
  getHumanEdits: () => EditOperation[];
  getExternalEdits: () => EditOperation[];
  reload: () => Promise<void>;
  updateContent: (newContent: string, source: EditSource) => void;
  markSaved: () => void;
  discardChanges: () => void;
}

export interface UnsavedContentCache {
  content: string;
  version: number;
  diskVersion: number;
  recentEdits: EditOperation[];
  /**
   * `true` when the buffer differed from its disk baseline at cache time.
   * Dirty entries are never evicted for size (evicting them would lose the
   * user's unsaved edits); clean entries (version bumped by an undo cycle,
   * a reload, etc.) only preserve edit history and are eviction candidates.
   */
  dirty: boolean;
}
