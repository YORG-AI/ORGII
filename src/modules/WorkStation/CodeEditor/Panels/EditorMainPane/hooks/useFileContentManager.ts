/**
 * useFileContentManager Hook
 *
 * Manages file content operations for the editor:
 * - Content change handling
 * - Save, discard, reload operations
 * - Integration with file content state
 *
 * Performance optimizations:
 * - Uses refs for stable callback references
 * - Avoids recreating callbacks when content changes
 */
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  type UseFileContentReturn,
  invalidateFileCache,
  useFileContent,
} from "@src/modules/WorkStation/CodeEditor/hooks/fileContent/useFileContent";

import type { UseFileContentManagerOptions } from "../types";

const log = createLogger("useFileContentManager");

// ============================================
// Helpers
// ============================================

function isCsvTableFile(filePath: string | null): boolean {
  if (!filePath) return false;
  const lowerPath = filePath.toLowerCase();
  return lowerPath.endsWith(".csv") || lowerPath.endsWith(".tsv");
}

// ============================================
// Return Type
// ============================================

export interface UseFileContentManagerReturn extends UseFileContentReturn {
  /** Whether save is in progress */
  saving: boolean;
  /** Handle content change from editor */
  handleContentChange: (newContent: string) => void;
  /** Save file to disk */
  handleSave: () => Promise<void>;
  /** Discard unsaved changes */
  handleDiscard: () => void;
  /** Reload file from disk */
  handleReload: () => Promise<void>;
}

// ============================================
// Hook Implementation
// ============================================

export function useFileContentManager(
  options: UseFileContentManagerOptions
): UseFileContentManagerReturn {
  const { activeFilePath, onSaveSuccess } = options;

  const shouldAutoLoadContent = !isCsvTableFile(activeFilePath);

  // Load file content for this pane's active tab
  const fileContentState = useFileContent({
    filePath: activeFilePath,
    autoLoad: shouldAutoLoadContent,
  });

  // Local saving state
  const [saving, setSaving] = useState(false);

  // PERFORMANCE: Create refs for use in callbacks (avoid stale closures)
  const fileContentStateRef = useRef(fileContentState);
  const activeFilePathRef = useRef(activeFilePath);
  const onSaveSuccessRef = useRef(onSaveSuccess);

  // Keep refs updated
  useEffect(() => {
    fileContentStateRef.current = fileContentState;
    activeFilePathRef.current = activeFilePath;
    onSaveSuccessRef.current = onSaveSuccess;
  });

  // Handle content change (human edits from CodeMirror)
  const handleContentChange = useCallback((newContent: string) => {
    fileContentStateRef.current.updateContent(newContent, { type: "human" });
  }, []); // No dependencies - uses ref

  // Handle save
  const handleSave = useCallback(async () => {
    const filePath = activeFilePathRef.current;
    const contentState = fileContentStateRef.current;

    if (!filePath || !contentState.hasUnsavedChanges) return;

    setSaving(true);
    try {
      await writeTextFile(filePath, contentState.content);
      contentState.markSaved();

      // Dispatch file save event to Filesync output
      window.dispatchEvent(
        new CustomEvent("filesync:file-saved", {
          detail: { path: filePath },
        })
      );

      // Invalidate cache so other panes can see the update
      invalidateFileCache(filePath);

      // Notify success (e.g., refresh git status)
      onSaveSuccessRef.current?.();
    } catch (err) {
      log.error("[useFileContentManager] Save failed:", err);
    } finally {
      setSaving(false);
    }
  }, []); // No dependencies - uses refs

  // Listen for save-all-files event (from TabService/AI actions)
  useEffect(() => {
    const handleSaveAll = () => {
      const filePath = activeFilePathRef.current;
      const contentState = fileContentStateRef.current;
      if (filePath && contentState.hasUnsavedChanges) {
        handleSave();
      }
    };

    window.addEventListener("save-all-files", handleSaveAll);
    return () => {
      window.removeEventListener("save-all-files", handleSaveAll);
    };
  }, [handleSave]);

  // Handle discard
  const handleDiscard = useCallback(() => {
    fileContentStateRef.current.discardChanges();
  }, []); // No dependencies - uses ref

  // Handle reload
  const handleReload = useCallback(async () => {
    await fileContentStateRef.current.reload();
  }, []); // No dependencies - uses ref

  return useMemo<UseFileContentManagerReturn>(
    () => ({
      ...fileContentState,
      saving,
      handleContentChange,
      handleSave,
      handleDiscard,
      handleReload,
    }),
    [
      fileContentState,
      saving,
      handleContentChange,
      handleSave,
      handleDiscard,
      handleReload,
    ]
  );
}

export default useFileContentManager;
