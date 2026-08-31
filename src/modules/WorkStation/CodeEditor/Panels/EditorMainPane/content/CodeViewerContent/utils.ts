/**
 * Utility functions for CodeViewerContent
 */
import { decodeOctalPath } from "@src/util/file/pathUtils";
import { supportsPreviewToggle } from "@src/util/file/previewTypes";

import type { CodeViewerContentProps } from "./types";

// ============================================
// Path Utilities
// ============================================

/**
 * Get relative path from repo root.
 * Decodes octal-escaped non-ASCII bytes before normalizing so that
 * CJK/unicode filenames are not split into fake path segments.
 */
export function getRelativePath(filePath: string, repoPath: string): string {
  if (!filePath || !repoPath) return "";

  const decodedFile = decodeOctalPath(filePath);
  const decodedRepo = decodeOctalPath(repoPath);

  const normalizedFile = decodedFile.replace(/\\/g, "/");
  const normalizedRepo = decodedRepo.replace(/\\/g, "/");

  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length).replace(/^\//, "");
  }

  return decodedFile;
}

// ============================================
// File Type Detection
// ============================================

/**
 * Check if file is a markdown file
 */
export function isMarkdownFile(filePath: string): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return (
    lowerPath.endsWith(".md") ||
    lowerPath.endsWith(".mdc") ||
    lowerPath.endsWith(".markdown")
  );
}

/**
 * Check if file is an HTML file
 */
export function isHtmlFile(filePath: string): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".html") || lowerPath.endsWith(".htm");
}

/**
 * Check if file is a JSON file
 */
export function isJsonFile(filePath: string): boolean {
  if (!filePath) return false;
  return filePath.toLowerCase().endsWith(".json");
}

/**
 * Check if file is a CSV/TSV file
 */
export function isCsvFile(filePath: string): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".csv") || lowerPath.endsWith(".tsv");
}

/**
 * Check if file supports preview (markdown, HTML, JSON, CSV)
 */
export function isPreviewableFile(filePath: string): boolean {
  return supportsPreviewToggle(filePath);
}

// ============================================
// Memo Comparison
// ============================================

/**
 * Custom comparison function for memo - only re-render when data changes,
 * not when callback references change (callbacks use refs internally)
 */
export function arePropsEqual(
  prevProps: CodeViewerContentProps,
  nextProps: CodeViewerContentProps
): boolean {
  // Always re-render if these change (actual data)
  if (prevProps.selectedFile !== nextProps.selectedFile) return false;
  if (prevProps.fileContent !== nextProps.fileContent) return false;
  if (prevProps.loading !== nextProps.loading) return false;
  if (prevProps.error !== nextProps.error) return false;
  if (prevProps.repoPath !== nextProps.repoPath) return false;
  if (prevProps.hasUnsavedChanges !== nextProps.hasUnsavedChanges) return false;
  if (prevProps.saving !== nextProps.saving) return false;
  if (
    prevProps.requiresFilePreviewRoute !== nextProps.requiresFilePreviewRoute
  ) {
    return false;
  }
  if (prevProps.readOnly !== nextProps.readOnly) return false;
  if (prevProps.gitBaseContent !== nextProps.gitBaseContent) return false;
  if (prevProps.savedContent !== nextProps.savedContent) return false;
  if (prevProps.contentReady !== nextProps.contentReady) return false;
  if (prevProps.isDeletedFile !== nextProps.isDeletedFile) return false;

  // Callbacks are compared by existence only (not reference)
  // because we use refs internally
  if (!!prevProps.onFileSelect !== !!nextProps.onFileSelect) return false;
  if (!!prevProps.onContentChange !== !!nextProps.onContentChange) return false;
  if (!!prevProps.onSave !== !!nextProps.onSave) return false;
  if (!!prevProps.onDiscard !== !!nextProps.onDiscard) return false;
  if (!!prevProps.onReload !== !!nextProps.onReload) return false;
  if (!!prevProps.onCursorPositionChange !== !!nextProps.onCursorPositionChange)
    return false;

  return true;
}
