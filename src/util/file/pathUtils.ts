/**
 * File Path Utilities
 *
 * Shared utilities for extracting file information from paths.
 * Consolidates duplicate implementations across the codebase.
 */

// Matches backslash-escaped octal byte sequences (\NNN where N is 0-7)
// produced by git and some Rust serializers for non-ASCII filenames.
const OCTAL_ESCAPE_RE = /\\([0-3][0-7]{2})/g;

/**
 * Decode a path that may contain git/Rust-style octal-escaped bytes.
 *
 * Git and some Tauri serializers represent non-ASCII filename bytes as
 * `\NNN` (backslash + 3 octal digits). This converts them back to the
 * original UTF-8 characters. Also strips surrounding double-quotes that
 * git adds to escaped filenames.
 *
 * @example
 * decodeOctalPath('"Cafe\\303\\251.pdf"') // "Cafeé.pdf"
 * decodeOctalPath("plain-ascii.ts")              // "plain-ascii.ts" (no-op)
 */
export function decodeOctalPath(path: string): string {
  if (!path.includes("\\")) return path;

  let cleaned = path;
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }

  if (!OCTAL_ESCAPE_RE.test(cleaned)) return cleaned;

  const bytes: number[] = [];
  let idx = 0;
  while (idx < cleaned.length) {
    if (
      cleaned[idx] === "\\" &&
      idx + 3 < cleaned.length &&
      /^[0-3][0-7]{2}$/.test(cleaned.slice(idx + 1, idx + 4))
    ) {
      bytes.push(parseInt(cleaned.slice(idx + 1, idx + 4), 8));
      idx += 4;
    } else {
      bytes.push(cleaned.charCodeAt(idx));
      idx += 1;
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Strip the Windows extended-length ("verbatim") `\\?\` prefix (and a leading
 * `file://` scheme) so a path can be passed to the Tauri fs plugin
 * (`@tauri-apps/plugin-fs`), which cannot parse `\\?\` paths.
 *
 * Repo paths arrive in `\\?\C:\…` form because the Rust backend canonicalizes
 * them (`std::fs::canonicalize` returns verbatim paths on Windows). The fs
 * plugin then silently fails on them — e.g. `readDir` returns nothing (file
 * tree shows the root but no children) and `exists` rejects. This is a no-op on
 * already-normal paths (macOS/Linux, or Windows paths without the prefix), so
 * it's safe to apply unconditionally before any fs-plugin call.
 *
 * NOTE: only for filesystem-plugin calls — do NOT use this to derive repo
 * identity/keys (the `\\?\` form is part of the stored repo id).
 *
 * @example
 * toFsPluginPath("\\\\?\\C:\\Projects\\ORGII") // "C:\\Projects\\ORGII"
 * toFsPluginPath("\\\\?\\UNC\\srv\\share")      // "\\\\srv\\share"
 * toFsPluginPath("/Users/me/repo")               // "/Users/me/repo"
 */
export function toFsPluginPath(path: string): string {
  if (!path) return "";
  const withoutScheme = path.startsWith("file://") ? path.slice(7) : path;
  return withoutScheme
    .replace(/^\\\\\?\\UNC\\/, "\\\\") // \\?\UNC\srv\share -> \\srv\share
    .replace(/^\\\\\?\\/, ""); // \\?\C:\dir         -> C:\dir
}

/**
 * Get file extension from file path
 * @param filePath - Full file path or filename
 * @returns File extension (without dot) or empty string if no extension
 *
 * @example
 * getFileExtension("src/components/Button.tsx") // "tsx"
 * getFileExtension("README") // ""
 * getFileExtension(".gitignore") // "gitignore"
 */
export function getFileExtension(filePath: string): string {
  if (!filePath) return "";
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

/**
 * Get file name from file path
 * @param filePath - Full file path
 * @returns File name (with extension) or original path if no separator
 *
 * @example
 * getFileName("src/components/Button.tsx") // "Button.tsx"
 * getFileName("README.md") // "README.md"
 * getFileName("file") // "file"
 */
export function getFileName(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

export function getPathSegments(filePath: string): string[] {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

export function getCompactPathLabel(filePath: string, maxSegments = 3): string {
  const segments = getPathSegments(filePath);
  const separator = filePath.includes("\\") ? "\\" : "/";
  return segments.slice(-maxSegments).join(separator) || filePath;
}

export function joinPathForDisplay(
  parentPath: string,
  childName: string
): string {
  const trimmedParent = parentPath.trim();
  const trimmedChild = childName.trim();
  const separator = trimmedParent.includes("\\") ? "\\" : "/";
  if (!trimmedParent) return trimmedChild;
  if (!trimmedChild) return trimmedParent;
  return trimmedParent.endsWith("/") || trimmedParent.endsWith("\\")
    ? `${trimmedParent}${trimmedChild}`
    : `${trimmedParent}${separator}${trimmedChild}`;
}

export function normalizeDiffFilePath(filePath: string): string {
  let normalized = filePath.trim().replace(/\\/g, "/");
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("a/") || normalized.startsWith("b/")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Get base name (filename without extension) from file path
 * @param filePath - Full file path
 * @returns Base name without extension
 *
 * @example
 * getBaseName("src/components/Button.tsx") // "Button"
 * getBaseName("README.md") // "README"
 * getBaseName("file") // "file"
 */
export function getBaseName(filePath: string): string {
  const fileName = getFileName(filePath);
  const extension = getFileExtension(fileName);
  if (!extension) return fileName;
  return fileName.slice(0, fileName.length - extension.length - 1);
}

/**
 * Get directory path from file path
 * @param filePath - Full file path
 * @returns Directory path (without filename) or empty string if no directory
 *
 * @example
 * getDirectory("src/components/Button.tsx") // "src/components"
 * getDirectory("README.md") // ""
 * getDirectory("file") // ""
 */
export function getDirectory(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlashIndex = normalized.lastIndexOf("/");
  return lastSlashIndex === -1 ? "" : normalized.substring(0, lastSlashIndex);
}

/**
 * Get file extension in lowercase
 * Convenience function for case-insensitive extension matching
 * @param filePath - Full file path or filename
 * @returns Lowercase file extension
 */
export function getFileExtensionLower(filePath: string): string {
  return getFileExtension(filePath).toLowerCase();
}
