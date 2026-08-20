/**
 * Shared types for useCodeEditor hook
 */
import type {
  FileNode,
  FileSearchResult,
} from "@src/store/workstation/codeEditor/file";
import type { WorkspaceFolder } from "@src/types/workspace";

// Re-export types from store for consumers
export type { FileNode, FileSearchResult };

export interface UseCodeEditorOptions {
  repoPath: string;
  repoId?: string;
  autoLoad?: boolean;
  /** Multi-root workspace folders (when set, overrides single repoPath for file tree) */
  workspaceFolders?: WorkspaceFolder[];
}

export interface UseCodeEditorReturn {
  // State
  selectedFile: string | null;
  fileTree: FileNode[];
  searchQuery: string;
  searchResults: FileSearchResult[];
  fileContent: string;
  loading: boolean;
  treeError: string | null;
  contentError: string | null;
  searchError: string | null;
  saveError: string | null;
  loadingTree: boolean;
  loadingContent: boolean;
  searchLoading: boolean;
  saving: boolean;
  hasUnsavedChanges: boolean;
  isBinary: boolean;

  // Actions (original format)
  loadFileTree: () => Promise<void>;
  loadFileContent: (filePath: string) => Promise<void>;
  saveFileContent: (filePath: string, content: string) => Promise<boolean>;
  selectFile: (path: string) => void;
  searchFiles: (query: string) => Promise<void>;
  toggleDirectory: (path: string) => void;
  clearSearch: () => void;
  refresh: () => Promise<void>;
  collapseAll: () => void;
  updateFileContent: (content: string) => void;
  markSaved: () => void;
  discardChanges: () => void;
  revealFile: (filePath: string) => Promise<void>;

  // Standardized actions sub-object for dispatcher integration
  actions: {
    open: (path: string) => void;
    save: (filePath: string, content: string) => Promise<boolean>;
    reveal: (filePath: string) => Promise<void>;
    search: (query: string) => Promise<void>;
    refresh: () => Promise<void>;
    discard: () => void;
  };
}
