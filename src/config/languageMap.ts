/**
 * Compatibility entry point for editor/LSP language detection.
 *
 * The canonical metadata lives in languageRegistry so editor IDs, syntax
 * highlighter IDs, display labels, and icon filenames do not drift apart.
 */
import {
  LANGUAGE_MAP,
  getEditorLanguageFromExtension,
  getEditorLanguageFromPath,
} from "./languageRegistry";

export {
  LANGUAGE_DISPLAY_NAMES,
  LANGUAGE_METADATA,
  SPECIAL_FILENAMES,
  getLanguageDisplayName,
  getLanguageDisplayNameFromPath,
  getLanguageIconFile,
  getLanguageMetadata,
  getLanguageMetadataFromExtension,
  getLanguageMetadataFromPath,
  getSyntaxHighlighterLanguage,
  getSyntaxHighlighterLanguageFromPath,
} from "./languageRegistry";
export { LANGUAGE_MAP };
export type {
  LanguageExtensionMetadata,
  LanguageMetadata,
} from "./languageRegistry";

/** Get the editor/LSP language identifier for an extension. */
export function getLanguageFromExtension(
  extension: string,
  fallback?: string
): string | undefined {
  return getEditorLanguageFromExtension(extension, fallback);
}

/** Get the editor/LSP language identifier for a file path. */
export function getLanguageFromPath(
  filePath: string | undefined | null,
  fallback?: string
): string | undefined {
  return getEditorLanguageFromPath(filePath, fallback);
}

/** Check if an editor/LSP language identifier is recognized. */
export function isKnownLanguage(language: string): boolean {
  return Object.values(LANGUAGE_MAP).includes(language);
}

// ============================================
// LSP Support (for CodeMirror linter)
// ============================================

/**
 * Languages with LSP servers configured in the Rust backend.
 * The LspClientManager normalizes variants (e.g., scss→css) so
 * each base language shares a single server process.
 */
export const LANGUAGES_WITH_LSP = new Set([
  // Web
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  "json",
  "jsonc",
  "vue",
  "svelte",
  // Systems
  "rust",
  "c",
  "cpp",
  "go",
  "zig",
  // JVM
  "java",
  "kotlin",
  "scala",
  // Scripting
  "python",
  "ruby",
  "php",
  "lua",
  "elixir",
  // Apple / Microsoft
  "swift",
  "csharp",
  // Functional
  "haskell",
  "ocaml",
  "clojure",
  "clojurescript",
  // Config / Data
  "yaml",
  "markdown",
  "mdx",
  // Shell / DevOps
  "shellscript",
  "dockerfile",
  "sql",
]);

/** Check if a file has LSP support based on its path. */
export function hasLspSupport(filePath: string): boolean {
  const language = getLanguageFromPath(filePath);
  return language ? LANGUAGES_WITH_LSP.has(language) : false;
}
