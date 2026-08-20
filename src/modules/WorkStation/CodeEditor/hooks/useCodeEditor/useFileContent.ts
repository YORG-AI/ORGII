/**
 * useFileContent - File content management sub-hook
 *
 * Handles loading, saving, updating, and discarding file content.
 * Manages binary file detection and unsaved changes tracking.
 */
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  fileContentAtom,
  fileContentErrorAtom,
  fileHasUnsavedChangesAtom,
  fileIsBinaryAtom,
  fileLoadingContentAtom,
  fileSaveErrorAtom,
  fileSavedContentAtom,
  fileSavingAtom,
} from "@src/store/workstation/codeEditor/file";
import {
  getBinaryFileMessage,
  isBinaryByExtension,
  isBinaryContent,
} from "@src/util/file/binaryDetection";
import { toFsPluginPath } from "@src/util/file/pathUtils";

const log = createLogger("useCodeEditor");

// ============================================
// Types
// ============================================

export interface UseFileContentReturn {
  fileContent: string;
  loadingContent: boolean;
  contentError: string | null;
  saveError: string | null;
  saving: boolean;
  hasUnsavedChanges: boolean;
  isBinary: boolean;
  loadFileContent: (filePath: string) => Promise<void>;
  saveFileContent: (filePath: string, content: string) => Promise<boolean>;
  updateFileContent: (content: string) => void;
  markSaved: () => void;
  discardChanges: () => void;
}

// ============================================
// Hook
// ============================================

export function useFileContent(): UseFileContentReturn {
  // State
  const [fileContent, setFileContent] = useAtom(fileContentAtom);
  const [savedContent, setSavedContent] = useAtom(fileSavedContentAtom);
  const [isBinary, setIsBinary] = useAtom(fileIsBinaryAtom);
  const [loadingContent, setLoadingContent] = useAtom(fileLoadingContentAtom);
  const [contentError, setContentError] = useAtom(fileContentErrorAtom);
  const [saving, setSaving] = useAtom(fileSavingAtom);
  const [saveError, setSaveError] = useAtom(fileSaveErrorAtom);
  const hasUnsavedChanges = useAtomValue(fileHasUnsavedChangesAtom);

  // ============================================
  // Load file content from disk
  // ============================================

  const loadFileContent = useCallback(
    async (filePath: string) => {
      if (!filePath) return;

      setLoadingContent(true);
      setContentError(null);
      setIsBinary(false);

      try {
        // Check if file is binary by extension/pattern first
        if (isBinaryByExtension(filePath)) {
          setIsBinary(true);
          setFileContent(getBinaryFileMessage());
          setSavedContent("");
          setLoadingContent(false);
          return;
        }

        const content = await readTextFile(toFsPluginPath(filePath));

        // Check if content is binary
        if (isBinaryContent(content)) {
          setIsBinary(true);
          setFileContent(getBinaryFileMessage());
          setSavedContent("");
          setLoadingContent(false);
          return;
        }

        setFileContent(content);
        setSavedContent(content);
        setIsBinary(false);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to load file content";
        setContentError(errorMessage);
        log.error("[useCodeEditor] Error loading file content:", err);
        setFileContent("");
        setSavedContent("");
        setIsBinary(false);
      } finally {
        setLoadingContent(false);
      }
    },
    [
      setLoadingContent,
      setContentError,
      setIsBinary,
      setFileContent,
      setSavedContent,
    ]
  );

  // ============================================
  // Save file content to disk
  // ============================================

  const saveFileContent = useCallback(
    async (filePath: string, content: string): Promise<boolean> => {
      if (!filePath) return false;

      setSaving(true);
      setSaveError(null);

      try {
        await writeTextFile(filePath, content);
        setSavedContent(content);

        // Dispatch event for Filesync channel logging
        window.dispatchEvent(
          new CustomEvent("filesync:file-saved", {
            detail: { path: filePath },
          })
        );

        return true;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to save file";
        setSaveError(errorMessage);
        log.error("[useCodeEditor] Error saving file:", err);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [setSaving, setSaveError, setSavedContent]
  );

  // ============================================
  // Content update helpers
  // ============================================

  /** Update file content (marks as unsaved via derived atom) */
  const updateFileContent = useCallback(
    (content: string) => {
      setFileContent(content);
    },
    [setFileContent]
  );

  /** Mark current content as saved */
  const markSaved = useCallback(() => {
    setSavedContent(fileContent);
  }, [fileContent, setSavedContent]);

  /** Discard unsaved changes (revert to last saved content) */
  const discardChanges = useCallback(() => {
    setFileContent(savedContent);
  }, [savedContent, setFileContent]);

  return {
    fileContent,
    loadingContent,
    contentError,
    saveError,
    saving,
    hasUnsavedChanges,
    isBinary,
    loadFileContent,
    saveFileContent,
    updateFileContent,
    markSaved,
    discardChanges,
  };
}
