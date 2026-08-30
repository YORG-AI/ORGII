import type { SourceLocation } from "../useWebviewInspector";

export interface SearchMatch {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  content: string;
  context_before: string[];
  context_after: string[];
}

export interface CodeSearchResult {
  file_path: string;
  matches: SearchMatch[];
}

export interface SearchFilters {
  file_extensions?: string[];
  exclude_dirs?: string[];
  case_sensitive?: boolean;
  whole_word?: boolean;
  use_regex?: boolean;
  max_results?: number;
}

export interface UseSourceNavigationOptions {
  repoPath: string;
  onSearchFiles?: (query: string) => void;
}

export interface ComponentSearchResult {
  path: string;
  line?: number;
}

export interface UseSourceNavigationReturn {
  openFileAtLine: (path: string, line?: number) => Promise<boolean>;
  canSearchForComponent: (sourceLocation: SourceLocation | null) => boolean;
  searchForComponent: (
    sourceLocation: SourceLocation
  ) => Promise<ComponentSearchResult[]>;
}
