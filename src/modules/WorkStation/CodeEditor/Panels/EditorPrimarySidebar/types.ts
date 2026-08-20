/**
 * EditorPrimarySidebar Types
 *
 * TypeScript type definitions for the EditorPrimarySidebar component.
 */
import type {
  FileNode,
  FileSearchResult,
} from "@src/modules/WorkStation/CodeEditor/hooks/useCodeEditor";
import type { PrimarySidebarTabKey } from "@src/store/ui/workStationAtom";
import type { GitFile } from "@src/types/git/types";

// ============================================
// View Modes
// ============================================

/** Alias for PrimarySidebarTabKey - single source of truth is in store */
export type EditorPrimarySidebarViewMode = PrimarySidebarTabKey;

/** Convenience alias used by sidebar hooks */
export type ExplorerViewMode = PrimarySidebarTabKey;

// ============================================
// Main Props
// ============================================

export interface EditorPrimarySidebarProps {
  /** File tree structure */
  fileTree: FileNode[];
  /** Selected commit SHA (from active timeline diff tab) */
  selectedCommitSha?: string | null;
  /** Loading state */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Repository path (for tree reconstruction) */
  repoPath: string;
  /** Repository ID for git operations */
  repoId?: string;
  /** Repository name for display */
  repoName?: string;
  /**
   * Search results from file system search (searchFilesNative).
   * Used to build tree structure for comprehensive search results.
   */
  searchResults?: FileSearchResult[];
  /** Whether search is in progress */
  searchLoading?: boolean;
  /** Current search query (managed by useFilterState) */
  searchQuery?: string;
  /** Callback when a file is selected */
  onFileSelect: (path: string) => void;
  /** Callback when a file is selected with line navigation (e.g., from search results) */
  onFileSelectWithLine?: (path: string, line: number) => void;
  /** Callback when a directory is toggled */
  onDirectoryToggle: (path: string) => void;
  /** Callback when search button is clicked */
  onSearchClick: () => void;
  /** Callback when refresh is clicked */
  onRefresh?: () => void;
  /** Callback when collapse all is clicked */
  onCollapseAll?: () => void;
  /** Callback for filter search */
  onFilterSearch?: (query: string) => void;
  /** Callback to clear search */
  onClearSearch?: () => void;
  /** Callback when tab changes */
  onTabChange?: (tab: EditorPrimarySidebarViewMode) => void;
  /** Callback when a git file is selected in Source Control tab */
  onGitFileSelect?: (file: GitFile) => void;
  /** Whether to show only icons in tabs (VSCode style, default: true) */
  iconOnly?: boolean;
  /** Callback when a symbol is clicked in outline (navigate to line) */
  onSymbolClick?: (line: number) => void;
  /** Callback when a timeline commit is clicked (opens diff view) */
  onTimelineCommitClick?: (
    commitSha: string,
    filePath: string,
    commitInfo: {
      sha: string;
      shortSha: string;
      message: string;
      author: string;
      timestamp: string;
    }
  ) => void;
  /** Callback to reveal a file in the explorer (expand parents and select) */
  onRevealFile?: (filePath: string) => Promise<void>;
  /** Callback to open search in a main editor tab */
  onOpenSearchTab?: () => void;
  /** Whether the workspace has multiple root folders */
  isMultiRoot?: boolean;
}

// ============================================
// Filter State
// ============================================

export interface FilterState {
  filterQuery: string;
  showFilterFiles: boolean;
  showFilterSourceControl: boolean;
  handleToggleFilterFiles: () => void;
  handleToggleFilterSourceControl: () => void;
  handleFilterChange: (query: string) => void;
}

// ============================================
// Reveal State
// ============================================

export interface RevealRequest {
  path: string;
  timestamp: number;
}
