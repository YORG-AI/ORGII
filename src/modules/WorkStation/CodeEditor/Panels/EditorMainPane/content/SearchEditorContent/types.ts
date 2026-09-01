/**
 * SearchEditorContent Types
 *
 * Types for the full-tab search editor component (browser URL-bar style)
 */
import type { ReactNode } from "react";

import type { SearchOptions as StoreSearchOptions } from "@src/store/workstation/codeEditor/search";

import type { SearchMode } from "../../../shared/SearchModeSelect";

export type {
  SearchMatch,
  SearchResultFile,
} from "../../../EditorPrimarySidebar/content/SearchContent/types";
export type { SearchMode } from "../../../shared/SearchModeSelect";

/**
 * Props for SearchBar component
 */
export interface SearchBarProps {
  /** Current search query */
  query: string;
  /** Callback when query changes */
  onQueryChange: (query: string) => void;
  /** Current search mode */
  mode: SearchMode;
  /** Callback when mode changes */
  onModeChange: (mode: SearchMode) => void;
  /** Whether advanced search modes are available */
  /** Whether search is loading */
  isLoading?: boolean;
  /** Search options state */
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  /** Option toggle callbacks */
  onCaseSensitiveToggle: () => void;
  onWholeWordToggle: () => void;
  onRegexToggle: () => void;
  /** Optional right-side action button/content */
  rightAction?: ReactNode;
  /** Additional class name */
  className?: string;
}

/**
 * Props for SearchEditorContent component
 */
export interface SearchEditorContentProps {
  /** Unique session scope key (tab id) for state isolation and caching */
  sessionScopeId: string;
  /** Repository path to search in */
  repoPath: string;
  /** Initial query seeded when opening from sidebar */
  initialQuery?: string;
  /** Initial options seeded when opening from sidebar */
  initialOptions?: StoreSearchOptions;
  /** Notify parent when query changes so tab title can mirror VSCode style */
  onQueryChangeForTitle?: (tabId: string, query: string) => void;
  /** Callback when a search result is clicked */
  onResultClick: (filePath: string, line: number, column?: number) => void;
  /** List of open file paths (for "Only search in open files" feature) */
  openFiles?: string[];
}
