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

export { getLanguageDisplayName, getLanguageIconFile } from "./languageMap";
