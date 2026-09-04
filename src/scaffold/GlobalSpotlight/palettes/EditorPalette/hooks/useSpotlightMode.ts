/**
 * useSpotlightMode Hook
 *
 * Detects mode from query prefix and strips the prefix
 */
import { useMemo } from "react";

import { EDITOR_PALETTE_CONFIG } from "../../config";
import type { EditorPaletteMode, ModeDetectionResult } from "../types";

const MODE_PREFIXES = EDITOR_PALETTE_CONFIG.prefixes;

/**
 * Detect spotlight mode from query string
 */
function detectMode(
  query: string,
  defaultMode: EditorPaletteMode = "file"
): ModeDetectionResult {
  if (!query) {
    return { mode: defaultMode, searchTerm: "" };
  }

  const firstChar = query[0];

  // Check if first character is a mode prefix
  if (MODE_PREFIXES[firstChar]) {
    return {
      mode: MODE_PREFIXES[firstChar] as EditorPaletteMode,
      searchTerm: query.slice(1).trimStart(),
    };
  }

  return {
    mode: defaultMode,
    searchTerm: query,
  };
}

/**
 * Hook to manage spotlight mode detection
 */
export function useSpotlightMode(
  query: string,
  defaultMode: EditorPaletteMode = "file"
): ModeDetectionResult {
  return useMemo(() => detectMode(query, defaultMode), [query, defaultMode]);
}

export default useSpotlightMode;
