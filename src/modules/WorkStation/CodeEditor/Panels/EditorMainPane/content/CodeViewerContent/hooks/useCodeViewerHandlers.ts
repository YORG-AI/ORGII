/**
 * Hook for CodeViewerContent state management and handlers
 *
 * Encapsulates all state, memos, callbacks, and effects for the code viewer.
 * Performance optimized with refs for stable callback references.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Message } from "@src/components/Message";
import type {
  ConflictResolutionChoice,
  CursorPosition,
  TextSelectionInfo,
} from "@src/features/CodeMirror";
import { hasConflictMarkers } from "@src/features/CodeMirror";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { editorAutoSaveAtom } from "@src/store/ui/editorSettingsAtom";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";

import type {
  CallbackRefs,
  CodeViewerContentProps,
  SelectionDropdownState,
} from "../types";
import {
  isCsvFile,
  isHtmlFile,
  isJsonFile,
  isMarkdownFile,
  isPreviewableFile,
} from "../utils";
import {
  scheduleAutoSaveTimer,
  shouldScheduleAutoSave,
} from "./autoSaveScheduler";

// ============================================
// Hook Return Type
// ============================================

export interface UseCodeViewerHandlersReturn {
  // State
  localContent: string;
  selectionDropdown: SelectionDropdownState | null;
  isPreviewMode: boolean;

  // Derived state
  isMarkdown: boolean;
  isHtml: boolean;
  isJson: boolean;
  isCsv: boolean;
  isPreviewable: boolean;
  fileHasConflicts: boolean;

  // Handlers
  handleContentChange: (content: string) => void;
  handleCursorChange: (cursor: CursorPosition) => void;
  handleTextSelection: (selection: TextSelectionInfo | null) => void;
  handleSave: () => Promise<void>;
  handleDiscard: () => void;
  handleReload: () => Promise<void>;
  handleFileSelect: (filePath: string) => void;
  handleTogglePreview: () => void;
  handleResolveConflict: (
    conflictId: string,
    choice: ConflictResolutionChoice
  ) => void;
  handleAskAgent: (text: string) => void;
  handleAddToContext: (text: string, sessionId: string | null) => void;
  handleCloseSelectionDropdown: () => void;
}

// ============================================
// Internal Types
// ============================================

interface LocalContentState {
  file: string | null;
  externalContent: string;
  editedContent: string;
}

// ============================================
// Main Hook
// ============================================

export function useCodeViewerHandlers(
  props: CodeViewerContentProps
): UseCodeViewerHandlersReturn {
  const {
    selectedFile,
    fileContent,
    loading,
    error,
    hasUnsavedChanges = false,
    saving = false,
    requiresFilePreviewRoute = false,
    defaultPreviewMode = false,
    readOnly = false,
    contentReady = true,
    onFileSelect,
    onContentChange,
    onSave,
    onDiscard,
    onReload,
    onCursorPositionChange,
  } = props;

  const { t } = useTranslation();

  const setAddToAgent = useSetAtom(addToAgentAtom);
  const autoSaveEnabled = useAtomValue(editorAutoSaveAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);

  // Store local content alongside its source key to avoid setState during render.
  // When selectedFile or fileContent changes, stale data is filtered during render
  // instead of calling setState synchronously.
  const [localState, setLocalState] = useState<LocalContentState>({
    file: selectedFile,
    externalContent: fileContent,
    editedContent: fileContent,
  });

  // Track the last content that was edited locally to prevent sync loops
  const lastLocalEditRef = useRef<string | null>(null);
  const localEditVersionRef = useRef(0);
  const lastAutoSaveAttemptVersionRef = useRef(0);

  const sourceChanged =
    localState.file !== selectedFile ||
    localState.externalContent !== fileContent;
  const localContent = sourceChanged ? fileContent : localState.editedContent;

  // Lazily sync state to match new source (runs once per source change, in an effect)
  useEffect(() => {
    setLocalState((prev) => {
      if (prev.file === selectedFile && prev.externalContent === fileContent) {
        return prev;
      }
      const isOwnEdit = lastLocalEditRef.current === fileContent;
      if (!isOwnEdit) {
        lastLocalEditRef.current = null;
      }
      return {
        file: selectedFile,
        externalContent: fileContent,
        editedContent: isOwnEdit ? prev.editedContent : fileContent,
      };
    });
  }, [selectedFile, fileContent]);

  // ============================================
  // UI State
  // ============================================

  const [selectionDropdown, setSelectionDropdown] =
    useState<SelectionDropdownState | null>(null);
  const selectionDropdownRef = useRef(selectionDropdown);
  useEffect(() => {
    selectionDropdownRef.current = selectionDropdown;
  }, [selectionDropdown]);

  const [isPreviewMode, setIsPreviewMode] = useState(false);

  // Reset preview mode when switching files. CSV/TSV opens in Table View so the
  // file content hook does not need to load the entire text before previewing.
  React.useEffect(() => {
    setIsPreviewMode(defaultPreviewMode || isCsvFile(selectedFile || ""));
    localEditVersionRef.current = 0;
    lastAutoSaveAttemptVersionRef.current = 0;
  }, [selectedFile, defaultPreviewMode]);

  // ============================================
  // File Type Detection
  // ============================================

  const isMarkdown = useMemo(
    () => isMarkdownFile(selectedFile || ""),
    [selectedFile]
  );

  const isHtml = useMemo(() => isHtmlFile(selectedFile || ""), [selectedFile]);

  const isJson = useMemo(() => isJsonFile(selectedFile || ""), [selectedFile]);

  const isCsv = useMemo(() => isCsvFile(selectedFile || ""), [selectedFile]);

  const isPreviewable = useMemo(
    () => isPreviewableFile(selectedFile || ""),
    [selectedFile]
  );

  // ============================================
  // Conflict Detection
  // ============================================

  const fileHasConflicts = useMemo(() => {
    return hasConflictMarkers(localContent);
  }, [localContent]);

  // ============================================
  // Callback Refs for Stable References
  // ============================================

  const callbackRefs = useRef<CallbackRefs>({});
  React.useEffect(() => {
    callbackRefs.current = {
      onFileSelect,
      onContentChange,
      onSave,
      onDiscard,
      onReload,
      onCursorPositionChange,
    };
  });

  // Reset cursor position when file changes
  React.useEffect(() => {
    callbackRefs.current.onCursorPositionChange?.({ line: 1, column: 1 });
  }, [selectedFile]);

  // ============================================
  // Content Handlers
  // ============================================

  const handleContentChange = useCallback((newContent: string) => {
    lastLocalEditRef.current = newContent;
    localEditVersionRef.current += 1;
    setLocalState((prev) => ({ ...prev, editedContent: newContent }));
    callbackRefs.current.onContentChange?.(newContent);
  }, []);

  const handleCursorChange = useCallback((cursor: CursorPosition) => {
    callbackRefs.current.onCursorPositionChange?.(cursor);
  }, []);

  const handleFileSelect = useCallback((filePath: string) => {
    callbackRefs.current.onFileSelect?.(filePath);
  }, []);

  const handleDiscard = useCallback(() => {
    callbackRefs.current.onDiscard?.();
  }, []);

  // ============================================
  // Save Handler
  // ============================================

  const handleSave = useCallback(async () => {
    if (callbackRefs.current.onSave && hasUnsavedChanges && !saving) {
      await callbackRefs.current.onSave();
    }
  }, [hasUnsavedChanges, saving]);

  useEffect(() => {
    const editVersion = localEditVersionRef.current;
    if (
      !shouldScheduleAutoSave({
        autoSaveEnabled,
        selectedFile,
        loading,
        error,
        isBinary: requiresFilePreviewRoute,
        readOnly,
        contentReady,
        hasUnsavedChanges,
        saving,
        hasSaveHandler: !!callbackRefs.current.onSave,
        editVersion,
        lastAttemptVersion: lastAutoSaveAttemptVersionRef.current,
      })
    ) {
      return;
    }

    const timer = scheduleAutoSaveTimer({
      editVersion,
      getCurrentEditVersion: () => localEditVersionRef.current,
      markAttempt: (version) => {
        lastAutoSaveAttemptVersionRef.current = version;
      },
      save: handleSave,
    });

    return () => clearTimeout(timer);
  }, [
    autoSaveEnabled,
    contentReady,
    error,
    handleSave,
    hasUnsavedChanges,
    requiresFilePreviewRoute,
    loading,
    readOnly,
    saving,
    selectedFile,
    localContent,
  ]);

  // ============================================
  // Reload Handler with Confirmation
  // ============================================

  const handleReload = useCallback(async () => {
    if (!callbackRefs.current.onReload) return;

    if (hasUnsavedChanges) {
      const confirmed = await askNativeDialogSafely(
        t("confirmation.reloadFileMessage"),
        {
          title: t("confirmation.reloadFileTitle"),
          kind: "warning",
          okLabel: t("actions.confirm"),
          cancelLabel: t("actions.cancel"),
        }
      );

      if (!confirmed) {
        return;
      }
    }

    await callbackRefs.current.onReload();
  }, [hasUnsavedChanges, t]);

  // ============================================
  // Preview Toggle
  // ============================================

  const handleTogglePreview = useCallback(() => {
    setIsPreviewMode((prev) => {
      const nextPreviewMode = !prev;
      if (!nextPreviewMode && isCsv && !contentReady) {
        void callbackRefs.current.onReload?.();
      }
      return nextPreviewMode;
    });
  }, [contentReady, isCsv]);

  // ============================================
  // Conflict Resolution
  // ============================================

  const handleResolveConflict = useCallback(
    (_conflictId: string, _choice: ConflictResolutionChoice) => {
      // The conflict editor handles the content change internally
    },
    []
  );

  // ============================================
  // Text Selection Handlers
  // ============================================

  const handleTextSelection = useCallback(
    (selection: TextSelectionInfo | null) => {
      if (selection && selectedFile) {
        setSelectionDropdown({
          visible: true,
          position: selection.position,
          text: selection.text,
          fromLine: selection.fromLine,
          toLine: selection.toLine,
        });
      } else {
        setSelectionDropdown(null);
      }
    },
    [selectedFile]
  );

  const handleCloseSelectionDropdown = useCallback(() => {
    setSelectionDropdown(null);
  }, []);

  // ============================================
  // Agent Integration Handlers
  // ============================================

  const handleAskAgent = useCallback(
    (_text: string) => {
      const currentSelection = selectionDropdownRef.current;
      if (!selectedFile || !currentSelection) return;

      const fileName = selectedFile.split("/").pop() || selectedFile;

      setStationChatVisible("my-station", true);

      setAddToAgent({
        type: "lines",
        filePath: selectedFile,
        fileName,
        lineStart: currentSelection.fromLine,
        lineEnd: currentSelection.toLine,
      });

      Message.success(
        t("workstation.addedToAgent", {
          fileName: `Lines ${currentSelection.fromLine}~${currentSelection.toLine}`,
        })
      );
    },
    [selectedFile, t, setAddToAgent, setStationChatVisible]
  );

  const handleAddToContext = useCallback(
    (_text: string, _sessionId: string | null) => {
      if (!selectedFile) return;

      const fileName = selectedFile.split("/").pop() || selectedFile;

      setStationChatVisible("my-station", true);

      setAddToAgent({
        type: "file",
        filePath: selectedFile,
        fileName,
      });

      Message.success(t("workstation.addedToAgent", { fileName }));
    },
    [selectedFile, t, setAddToAgent, setStationChatVisible]
  );

  // ============================================
  // Keyboard Shortcuts Effect
  // ============================================

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Save: Cmd/Ctrl+S
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        handleSave();
      }
      // Reload: Cmd/Ctrl+Shift+R
      else if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key === "r"
      ) {
        event.preventDefault();
        handleReload();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave, handleReload]);

  // ============================================
  // Return
  // ============================================

  return {
    // State
    localContent,
    selectionDropdown,
    isPreviewMode,

    // Derived state
    isMarkdown,
    isHtml,
    isJson,
    isCsv,
    isPreviewable,
    fileHasConflicts,

    // Handlers
    handleContentChange,
    handleCursorChange,
    handleTextSelection,
    handleSave,
    handleDiscard,
    handleReload,
    handleFileSelect,
    handleTogglePreview,
    handleResolveConflict,
    handleAskAgent,
    handleAddToContext,
    handleCloseSelectionDropdown,
  };
}
