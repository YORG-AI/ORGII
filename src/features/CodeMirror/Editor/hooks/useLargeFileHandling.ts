/**
 * useLargeFileHandling Hook
 *
 * Automatically disables expensive features for large files to maintain performance.
 */
import { useEffect, useMemo } from "react";

import { LARGE_FILE_THRESHOLDS, getLineCount } from "../config";

export interface UseLargeFileHandlingOptions {
  /** File content to analyze */
  value: string;
  /** Whether minimap is enabled (before large file check) */
  enableMinimap: boolean;
  /** Whether indent guides are enabled (before large file check) */
  enableIndentGuides: boolean;
}

export interface LargeFileHandlingResult {
  /** Line count of the file */
  lineCount: number;
  /** Effective minimap setting (may be disabled for large files) */
  effectiveMinimap: boolean;
  /** Effective indent guides setting (may be disabled for large files) */
  effectiveIndentGuides: boolean;
}

/**
 * Hook to compute effective feature flags based on file size
 * Automatically disables expensive features for large files
 */
export function useLargeFileHandling(
  options: UseLargeFileHandlingOptions
): LargeFileHandlingResult {
  const { value, enableMinimap, enableIndentGuides } = options;

  const lineCount = useMemo(() => getLineCount(value), [value]);

  // Compute effective feature flags based on file size
  const effectiveMinimap =
    enableMinimap && lineCount < LARGE_FILE_THRESHOLDS.MINIMAP;
  const effectiveIndentGuides =
    enableIndentGuides && lineCount < LARGE_FILE_THRESHOLDS.INDENT_GUIDES;

  // Log when features are auto-disabled (dev only)
  useEffect(() => {
    if (process.env.NODE_ENV === "development" && lineCount > 0) {
      const disabled: string[] = [];
      if (enableMinimap && !effectiveMinimap)
        disabled.push(`minimap (>${LARGE_FILE_THRESHOLDS.MINIMAP} lines)`);
      if (enableIndentGuides && !effectiveIndentGuides)
        disabled.push(
          `indent guides (>${LARGE_FILE_THRESHOLDS.INDENT_GUIDES} lines)`
        );
      if (disabled.length > 0) {
        // Features disabled for large file - logged for debugging
      }
    }
  }, [
    lineCount,
    enableMinimap,
    effectiveMinimap,
    enableIndentGuides,
    effectiveIndentGuides,
  ]);

  return {
    lineCount,
    effectiveMinimap,
    effectiveIndentGuides,
  };
}
