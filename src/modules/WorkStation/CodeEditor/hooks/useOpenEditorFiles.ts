/**
 * useOpenEditorFiles Hook
 *
 * Returns a list of currently open file paths from all editor panes.
 * Used by search panel for "Only search in open files" feature.
 *
 * PERFORMANCE:
 * Uses openEditorFilePathsAtom for shared memoization so all consumers reuse
 * the same stable array reference when the open file set does not change.
 *
 */
import { useAtomValue } from "jotai";

import { openEditorFilePathsAtom } from "@src/store/workstation/tabs";

export interface UseOpenEditorFilesResult {
  /** Array of absolute file paths currently open in the editor */
  openFiles: string[];
}

/**
 * Get list of currently open file paths from all editor panes
 */
export function useOpenEditorFiles(): UseOpenEditorFilesResult {
  const openFiles = useAtomValue(openEditorFilePathsAtom);

  return { openFiles };
}
