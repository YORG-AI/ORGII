/**
 * Search API Types
 *
 * Shared type definitions for regex, symbol, streaming, and helper modules.
 */

export interface SearchMatch {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  text: string;
  context_before: string;
  context_after: string;
}

export interface CodeSearchResult {
  file_path: string;
  matches: SearchMatch[];
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
}

export interface SymbolSearchResult {
  file_path: string;
  symbols: SymbolInfo[];
}

export interface Location {
  file_path: string;
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  text: string;
}

export interface SearchFilters {
  file_extensions?: string[];
  exclude_dirs?: string[];
  case_sensitive?: boolean;
  whole_word?: boolean;
  use_regex?: boolean;
  max_results?: number;
}

export interface LanguageInfo {
  language_ids: string[];
  extensions: string[];
}

export interface SearchResultEvent {
  search_id: string;
  result: CodeSearchResult;
  emitted_matches: number;
  emitted_files: number;
  actual_matches: number;
  actual_files: number;
}

export interface SearchCompleteEvent {
  search_id: string;
  emitted_matches: number;
  emitted_files: number;
  total_matches: number;
  total_files: number;
  duration_ms: number;
  has_more: boolean;
}

export type SearchMode = "regex" | "symbol";
