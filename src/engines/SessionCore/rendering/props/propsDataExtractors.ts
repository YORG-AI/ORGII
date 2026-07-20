/**
 * Data Extractors — Re-export barrel
 *
 * The extractors are split into domain-specific modules for maintainability.
 * This file re-exports everything so existing import paths continue to work.
 */

// Shared utilities
export {
  safeText,
  extractSuccessData,
  extractFailureData,
  stripLineNumberPrefixes,
} from "./extractorShared";

// Domain extractors
export { extractThinkingData } from "./thinkingExtractors";
export { extractFileData } from "./fileExtractors";
export {
  extractEditData,
  extractApplyPatchDataFromRust,
  splitCombinedDiffIntoSegments,
} from "./editExtractors";
export { extractShellData } from "./shellExtractors";
export { extractSearchData } from "./searchExtractors";
export { extractTodoData } from "./todoExtractors";
