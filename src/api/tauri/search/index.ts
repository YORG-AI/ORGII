// ============================================
// Unified API Object
// ============================================
import {
  formatRelativePath,
  getFileExtension,
  getFileName,
  getTotalMatchCount,
  getTotalSymbolCount,
  groupSymbolsByKind,
  isCodeSearchAvailable,
} from "./helpers";
import {
  merkleBuildTree,
  merkleDiffSinceSnapshot,
  merkleGetStats,
} from "./merkle";
import {
  cancelSearch,
  clearSearchCache,
  searchCodeFast,
  searchCodeRegex,
  searchCodeStreaming,
} from "./regex";
import {
  findReferences,
  getFileSymbols,
  getSupportedLanguages,
  gotoDefinition,
  searchSymbols,
} from "./symbol";

/**
 * Code Search API
 *
 * TypeScript wrapper for Tauri code search commands.
 */
export type {
  SearchMatch,
  CodeSearchResult,
  SymbolInfo,
  SymbolSearchResult,
  Location,
  SearchFilters,
  LanguageInfo,
  SearchResultEvent,
  SearchCompleteEvent,
  SearchMode,
} from "./types";

export {
  searchCodeRegex,
  searchCodeStreaming,
  cancelSearch,
  searchCodeFast,
} from "./regex";

export {
  searchSymbols,
  getFileSymbols,
  gotoDefinition,
  findReferences,
  getSupportedLanguages,
} from "./symbol";

export {
  getTotalMatchCount,
  getTotalSymbolCount,
  groupSymbolsByKind,
  getFileExtension,
  getFileName,
  formatRelativePath,
} from "./helpers";

export const searchApi = {
  searchCodeRegex,
  searchCodeStreaming,
  searchCodeFast,
  cancelSearch,
  clearSearchCache,
  searchSymbols,
  getFileSymbols,
  gotoDefinition,
  findReferences,
  getSupportedLanguages,
  merkleBuildTree,
  merkleDiffSinceSnapshot,
  merkleGetStats,
  isCodeSearchAvailable,
  getTotalMatchCount,
  getTotalSymbolCount,
  groupSymbolsByKind,
  getFileExtension,
  getFileName,
  formatRelativePath,
};

export default searchApi;
