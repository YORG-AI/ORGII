/**
 * useFileHandlers Hook
 *
 * Handles file drops into the chat input by routing them through
 * `droppedFilesAtom` (consumed by useInputAreaEffects).
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { droppedFilesAtom } from "@src/store/ui/dragDropAtom";
import { editorChatVisibleAtom } from "@src/store/workstation/codeEditor/editor";

import type { DroppedFileInfo } from "../types";

export interface UseFileHandlersReturn {
  handleIdeFileDrop: (
    filePath: string,
    fileName?: string,
    isFolder?: boolean,
    dropTargetId?: string
  ) => void;
  handleBrowserFileDrop: (
    file: File,
    isFolder?: boolean,
    dropTargetId?: string
  ) => void;
}

export function useFileHandlers(): UseFileHandlersReturn {
  const setDroppedFiles = useSetAtom(droppedFilesAtom);
  const setIsShowChat = useSetAtom(editorChatVisibleAtom);

  const handleIdeFileDrop = useCallback(
    (
      filePath: string,
      fileName?: string,
      isFolder?: boolean,
      dropTargetId?: string
    ) => {
      const pathParts = filePath.split("/");
      const finalFileName =
        fileName || pathParts[pathParts.length - 1] || "Unknown";

      const file: DroppedFileInfo = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        name: finalFileName,
        path: filePath,
        type: isFolder ? "folder" : "file",
        dropTargetId,
      };

      setDroppedFiles((prev) => [...prev, file]);
      setIsShowChat(true);
    },
    [setDroppedFiles, setIsShowChat]
  );

  const handleBrowserFileDrop = useCallback(
    (browserFile: File, isFolder?: boolean, dropTargetId?: string) => {
      const file: DroppedFileInfo = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        name: browserFile.name || "dropped-file",
        path: browserFile.name || "dropped-file",
        type: isFolder ? "folder" : "file",
        browserFile,
        dropTargetId,
      };

      setDroppedFiles((prev) => [...prev, file]);
      setIsShowChat(true);
    },
    [setDroppedFiles, setIsShowChat]
  );

  return {
    handleIdeFileDrop,
    handleBrowserFileDrop,
  };
}
