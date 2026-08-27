/**
 * Language Detection Utility
 *
 * Extracted from ChatCodeBlock/config.ts for reuse across components.
 * Detects programming language from file paths and extensions.
 */
import { getFileExtensionLower, getFileName } from "@src/util/file/pathUtils";

import { SPECIAL_FILENAMES } from "./languageMap";

/**
 * Detect language from file path
 *
 * Checks special filenames first (Makefile, Dockerfile, etc.),
 * then falls back to file extension.
 *
 * @param filePath - Full file path or filename
 * @returns Language code for syntax highlighting
 *
 * @example
 * detectLanguageFromPath("src/App.tsx") // "tsx"
 * detectLanguageFromPath("Dockerfile") // "dockerfile"
 * detectLanguageFromPath("script.py") // "py"
 * detectLanguageFromPath("unknown.xyz") // "xyz"
 */
export function detectLanguageFromPath(filePath: string): string {
  if (!filePath) return "text";

  const fileName = getFileName(filePath);

  // Check special filenames first
  if (SPECIAL_FILENAMES[fileName]) {
    return SPECIAL_FILENAMES[fileName];
  }

  // Fall back to extension
  const extension = getFileExtensionLower(fileName);
  return extension || "text";
}

/**
 * Detect language from extension only
 *
 * @param extension - File extension (with or without dot)
 * @returns Language code
 *
 * @example
 * detectLanguageFromExtension(".ts") // "ts"
 * detectLanguageFromExtension("js") // "js"
 */
export function detectLanguageFromExtension(extension: string): string {
  if (!extension) return "text";

  // Remove leading dot if present
  const ext = extension.startsWith(".") ? extension.slice(1) : extension;
  return ext.toLowerCase() || "text";
}

/**
 * Check if a file path is a diff file
 *
 * @param filePath - File path to check
 * @returns True if the file is a diff or patch file
 */
export function isDiffFile(filePath: string): boolean {
  const lang = detectLanguageFromPath(filePath);
  return lang === "diff" || lang === "patch";
}

/**
 * Check if a language is a code language (not text/markdown)
 *
 * @param language - Language code
 * @returns True if it's a programming language
 */
export function isCodeLanguage(language: string): boolean {
  const nonCodeLanguages = ["text", "markdown", "md", "plain"];
  return !nonCodeLanguages.includes(language.toLowerCase());
}
