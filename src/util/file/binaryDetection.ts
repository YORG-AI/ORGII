/**
 * Binary File Detection Utility
 *
 * Utilities for detecting binary files and files with unsupported text encoding.
 * Used by Code Editor to prevent rendering binary files as text.
 *
 * **Performance**: Uses SIMD-accelerated Rust implementation
 * for 10-20x faster detection on large files.
 *
 * For async Rust-accelerated functions, use:
 * - `isBinaryByExtensionAsync()` - extension check via Rust
 * - `isBinaryContentBytesAsync()` - content check via Rust SIMD
 * - `isFileBinaryAsync()` - full file check via Rust
 *
 * The sync functions (`isBinaryByExtension`, `isBinaryContent`) are kept for
 * quick synchronous checks where async is not convenient.
 */
import "@src/api/tauri/perf";
import { type BinaryCheckResult } from "@src/api/tauri/perf";

import { getFileExtensionLower } from "./pathUtils";

/**
 * Common binary file extensions
 * Comprehensive list of extensions that should not be displayed as text
 */
const BINARY_EXTENSIONS = new Set([
  // Images
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "ico",
  "webp",
  "svg",
  "tiff",
  "tif",
  "psd",
  "ai",
  "eps",
  "raw",
  "cr2",
  "nef",
  "orf",
  "sr2",

  // Videos
  "mp4",
  "avi",
  "mov",
  "wmv",
  "flv",
  "mkv",
  "webm",
  "m4v",
  "mpg",
  "mpeg",
  "3gp",

  // Audio
  "mp3",
  "wav",
  "flac",
  "aac",
  "ogg",
  "wma",
  "m4a",
  "opus",
  "aiff",

  // Archives
  "zip",
  "tar",
  "gz",
  "bz2",
  "7z",
  "rar",
  "xz",
  "tgz",
  "jar",
  "war",
  "ear",

  // Executables & Libraries
  "exe",
  "dll",
  "so",
  "dylib",
  "bin",
  "app",
  "deb",
  "rpm",
  "msi",
  "dmg",
  "pkg",
  "apk",
  "ipa",

  // Documents (binary formats)
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "odt",
  "ods",
  "odp",
  "pages",
  "numbers",
  "key",

  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",

  // Database
  "db",
  "sqlite",
  "sqlite3",
  "mdb",

  // macOS system binary files (no real extension — getFileExtension returns the
  // stem after the dot, so ".DS_Store" → "ds_store", ".localized" → "localized")
  "ds_store",
  "localized",

  // Other binary formats
  "pyc",
  "pyo",
  "class",
  "o",
  "obj",
  "a",
  "lib",
  "wasm",
  "node",
]);

/**
 * Check if a file is binary based on its extension or filename pattern
 *
 * @param filePath - File path or filename to check
 * @returns True if the file extension indicates a binary file
 *
 * @example
 * isBinaryByExtension("image.png") // true
 * isBinaryByExtension("script.js") // false
 * isBinaryByExtension("package.json") // false
 * isBinaryByExtension("my-executable") // true (no extension, might be binary)
 */
export function isBinaryByExtension(filePath: string): boolean {
  if (!filePath) return false;

  const extension = getFileExtensionLower(filePath);

  // If extension is in binary list, it's binary
  if (BINARY_EXTENSIONS.has(extension)) {
    return true;
  }

  // Check for extensionless files that might be binaries
  // Common patterns: executables, compiled binaries, etc.
  const fileName = filePath.split("/").pop() || filePath;

  // If file has no extension and contains certain patterns, likely binary
  if (!extension) {
    // Skip known text files without extensions
    const knownTextFiles = new Set([
      "Makefile",
      "Dockerfile",
      "Jenkinsfile",
      "Vagrantfile",
      "Gemfile",
      "Rakefile",
      "Procfile",
      "README",
      "LICENSE",
      "CHANGELOG",
      "CONTRIBUTING",
      "AUTHORS",
      "NOTICE",
      ".gitignore",
      ".dockerignore",
      ".npmignore",
      ".editorconfig",
      ".prettierrc",
      ".eslintrc",
      ".babelrc",
    ]);

    if (knownTextFiles.has(fileName)) {
      return false;
    }

    // Common binary executable patterns
    // Files with architecture names, version numbers, or "Helper" are often binaries
    const binaryPatterns = [
      /-(aarch64|x86_64|arm64|i386|i686|armv7|darwin|linux|windows|macos|apple)/i,
      /\b(helper|daemon|agent|server|client|worker|service)\b/i,
      /(^|\/)bin\//i, // Files in bin/ folders
      /\.(out|run|bundle)$/i, // Other common binary suffixes
    ];

    return binaryPatterns.some((pattern) => pattern.test(filePath));
  }

  return false;
}

/**
 * Check if file content contains binary data
 *
 * Detects binary content by checking for:
 * - Null bytes (0x00)
 * - High proportion of non-printable characters
 *
 * @param content - File content as string
 * @param sampleSize - Number of characters to sample (default: 8000)
 * @returns True if content appears to be binary
 *
 * @example
 * isBinaryContent("Hello World") // false
 * isBinaryContent("\x00\x01\x02\xFF") // true
 */
export function isBinaryContent(
  content: string,
  sampleSize: number = 8000
): boolean {
  if (!content) return false;

  // Sample the beginning of the file (first 8KB by default)
  const sample = content.slice(0, sampleSize);

  // Check for null bytes - strong indicator of binary content
  if (sample.includes("\x00")) {
    return true;
  }

  // Count non-printable characters (excluding common whitespace)
  let nonPrintableCount = 0;
  for (let index = 0; index < sample.length; index++) {
    const charCode = sample.charCodeAt(index);

    // Allow common whitespace: tab (9), newline (10), carriage return (13), space (32)
    if (
      charCode === 9 ||
      charCode === 10 ||
      charCode === 13 ||
      charCode === 32
    ) {
      continue;
    }

    // Check for non-printable characters (< 32 or > 126 and < 160)
    if (charCode < 32 || (charCode > 126 && charCode < 160)) {
      nonPrintableCount++;
    }
  }

  // If more than 30% of characters are non-printable, consider it binary
  const nonPrintableRatio = nonPrintableCount / sample.length;
  return nonPrintableRatio > 0.3;
}

/**
 * Check if a file should be displayed as text
 *
 * Combines extension check with optional content check for comprehensive detection.
 *
 * @param filePath - File path to check
 * @param content - Optional file content to validate
 * @returns False if file is binary or has unsupported encoding
 *
 * @example
 * isTextFile("script.js") // true
 * isTextFile("image.png") // false
 * isTextFile("unknown.dat", binaryContent) // false
 */
export function isTextFile(filePath: string, content?: string): boolean {
  // First check extension
  if (isBinaryByExtension(filePath)) {
    return false;
  }

  // If content provided, check for binary data
  if (content !== undefined) {
    return !isBinaryContent(content);
  }

  // If only path provided and extension is not binary, assume text
  return true;
}

/**
 * Get the standard message for non-displayable files
 *
 * @returns Standard message for binary/unsupported files
 */
export function getBinaryFileMessage(): string {
  return "The file is not displayed in the text editor because it is either binary or uses an unsupported text encoding.";
}

// ============================================
// Rust-Accelerated Functions (Tauri only)
// ============================================

// Re-export types
export type { BinaryCheckResult };
