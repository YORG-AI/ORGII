/**
 * Event Normalizer Module
 *
 * Exports props normalization and data extraction utilities.
 */

// Data extractors for specific event types
export { extractThinkingData } from "./thinkingExtractors";
export { extractFileData } from "./fileExtractors";
export { extractEditData } from "./editExtractors";
export { extractShellData } from "./shellExtractors";
export { extractSearchData } from "./searchExtractors";
export { extractTodoData } from "./todoExtractors";
export {
  parseUnifiedDiffToOldNew,
  stripLineNumberPrefixes,
} from "./extractorShared";

// React-flavored props normalizer
export {
  normalizeEventProps,
  useNormalizedEventProps,
  type RawEventInput,
} from "./propsNormalizer";
