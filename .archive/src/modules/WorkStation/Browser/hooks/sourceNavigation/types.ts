import type { SourceLocation } from "../useWebviewInspector";

// ============================================
// Types for Content Search
// ============================================

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

// ============================================
// Types for Component Index (AST-based lookup)
// ============================================

export interface IndexedComponentLocation {
  file: string;
  line: number;
  column: number;
  kind:
    | "function_def"
    | "arrow_def"
    | "class_def"
    | "jsx_usage"
    | "default_export"
    | "named_export"
    | "vue_def"
    | "svelte_def";
  end_line?: number;
}

export interface IndexStats {
  total_files: number;
  total_components: number;
  total_locations: number;
  index_time_ms: number;
}

// ============================================
// Public hook types
// ============================================

export interface UseSourceNavigationOptions {
  repoPath: string;
  onSearchFiles?: (query: string) => void;
}

export interface ComponentSearchResult {
  path: string;
  line?: number;
  isDefinition?: boolean;
}

export interface EnrichedSourceInfo {
  sourceLocation: SourceLocation | null;
  definition: ComponentSearchResult | null;
  usages: ComponentSearchResult[];
  loading: boolean;
}

export interface UseSourceNavigationReturn {
  openSourceLocation: (sourceLocation: SourceLocation) => Promise<boolean>;
  openFileAtLine: (path: string, line?: number) => Promise<boolean>;
  canOpenSource: (sourceLocation: SourceLocation | null) => boolean;
  canSearchForComponent: (sourceLocation: SourceLocation | null) => boolean;
  searchForComponent: (
    sourceLocation: SourceLocation
  ) => Promise<ComponentSearchResult[]>;
  enrichSourceLocation: (
    sourceLocation: SourceLocation | null
  ) => Promise<SourceLocation | null>;
  getDefinitionAndUsages: (sourceLocation: SourceLocation | null) => Promise<{
    definition: ComponentSearchResult | null;
    usages: ComponentSearchResult[];
  }>;
}
