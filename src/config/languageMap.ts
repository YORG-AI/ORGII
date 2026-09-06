/**
 * Compatibility entry point for editor/LSP language detection.
 *
 * The canonical metadata lives in languageRegistry so editor IDs, syntax
 * highlighter IDs, display labels, and icon filenames do not drift apart.
 */
import { LANGUAGE_MAP, getEditorLanguageFromPath } from "./languageRegistry";

export {
  SPECIAL_FILENAMES,
  getLanguageDisplayName,
  getLanguageDisplayNameFromPath,
  getLanguageIconFile,
  getLanguageMetadataFromExtension,
  getSyntaxHighlighterLanguage,
  getSyntaxHighlighterLanguageFromPath,
} from "./languageRegistry";
export { LANGUAGE_MAP };

/** Get the editor/LSP language identifier for a file path. */
export function getLanguageFromPath(
  filePath: string | undefined | null,
  fallback?: string
): string | undefined {
  return getEditorLanguageFromPath(filePath, fallback);
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
