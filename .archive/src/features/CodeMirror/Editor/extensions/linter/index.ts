/**
 * CodeMirror Linter Extension
 *
 * Provides LSP-based linting for CodeMirror editor using @codemirror/lint.
 * Collects diagnostics and reports them to the Problems Panel.
 *
 * Features:
 * - LSP integration for type errors (TypeScript, Rust, Python, etc.)
 * - ESLint integration for style/formatting errors (JS/TS files)
 * - Combined diagnostics from both sources
 */
import { linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";

import {
  LANGUAGES_WITH_LSP,
  getLanguageFromPath,
} from "@src/config/languageMap";

import { createCustomLinterExtension } from "./customLinter";
import { createLspLinterExtension } from "./lspLinter";
import type { LinterOptions } from "./types";

export type { LinterOptions } from "./types";
export { parseESLintOutput } from "./eslintParser";

/**
 * Create a linter extension for CodeMirror.
 *
 * Uses LSP for supported languages. Custom linter can be provided for
 * specialized use cases.
 */
export function createLinterExtension(options: LinterOptions): Extension {
  const { filePath, onDiagnosticsChange, customLinter } = options;

  // Check if file supports LSP (only languages with actual LSP servers)
  const language = getLanguageFromPath(filePath);
  const supportsLsp =
    language !== undefined && LANGUAGES_WITH_LSP.has(language);

  // Use custom linter if provided
  if (customLinter) {
    return createCustomLinterExtension(customLinter, onDiagnosticsChange);
  }

  // Use LSP-based linting for supported languages
  if (supportsLsp) {
    return createLspLinterExtension(filePath, language, onDiagnosticsChange);
  }

  // No linting available for this file type - return empty linter
  return linter(() => [], { delay: 500 });
}
