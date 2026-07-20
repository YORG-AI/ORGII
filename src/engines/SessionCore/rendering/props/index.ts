/**
 * Event Normalizer Module
 *
 * Exports props normalization and data extraction utilities.
 */

// Data extractors for specific event types
export {
  extractThinkingData,
  extractFileData,
  extractEditData,
  extractShellData,
  extractSearchData,
  extractTodoData,
  stripLineNumberPrefixes,
} from "./propsDataExtractors";

// React-flavored props normalizer
export {
  normalizeEventProps,
  useNormalizedEventProps,
  type RawEventInput,
} from "./propsNormalizer";
