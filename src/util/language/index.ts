/**
 * Language Detection and Mapping Utilities
 *
 * Exports language detection functions and mappings for use across components.
 */

export {
  detectLanguageFromPath,
  detectLanguageFromExtension,
  isDiffFile,
  isCodeLanguage,
} from "./detectLanguage";

export {
  LANGUAGE_DISPLAY_NAMES,
  SPECIAL_FILENAMES,
  getLanguageDisplayName,
  getLanguageIconFile,
} from "./languageMap";
