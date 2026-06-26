/**
 * useBrowserDragDrop Hook
 *
 * Handles browser drag-drop events via document-level listeners.
 *
 * Drag-drop is always globally active. File drops are accepted only on the
 * composer input drop target. Repository-folder drops still use the Start-page
 * surface.
 */
import { type MutableRefObject, useEffect } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { consumeInternalFileTreeDragData } from "@src/shared/dnd/dragSideChannel";

import type { DragDropBehavior, DroppedFolder } from "../types";
import {
  createPreventDefaults,
  extractFilePath,
  extractFilePathAsync,
  getChatDropTargetId,
  hasVisibleChatDropTarget,
  isDropInsideChatDropTarget,
  isInternalDrag,
  isRepositoryDropPage,
} from "./utils";

/**
 * Flip to `false` once the chat drag-drop flow is confirmed stable again.
 * Gated behind a constant (not a window flag) so we can easily grep for it
 * and so it strips cleanly when flipped.
 */
const DEBUG = false;

const moduleLog = createLogger("drag-drop");

function log(tag: string, payload: Record<string, unknown> = {}) {
  if (!DEBUG) return;
  moduleLog.debug(`[drag-drop] ${tag}`, payload);
}

function summarizeDataTransfer(
  dataTransfer: DataTransfer | null | undefined
): Record<string, unknown> {
  if (!dataTransfer) return { dataTransfer: null };
  const rawTypes = dataTransfer.types;
  const types = rawTypes ? Array.from(rawTypes) : [];
  const items = dataTransfer.items
    ? Array.from(dataTransfer.items).map((it) => ({
        kind: it.kind,
        type: it.type,
      }))
    : [];
  const files = dataTransfer.files
    ? Array.from(dataTransfer.files).map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
        path: (f as File & { path?: string }).path,
      }))
    : [];
  return {
    types,
    items,
    fileCount: files.length,
    files,
    effectAllowed: dataTransfer.effectAllowed,
    dropEffect: dataTransfer.dropEffect,
  };
}

export interface UseBrowserDragDropOptions {
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
  setDroppedFolder: (folder: DroppedFolder | null) => void;
  setIsDragging: (dragging: boolean) => void;
  setBehavior: (behavior: DragDropBehavior | null) => void;
  dragDepthRef: MutableRefObject<number>;
  appGridEditModeRef: MutableRefObject<boolean>;
  workflowDragActiveRef: MutableRefObject<boolean>;
  internalFileTreeDragRef: MutableRefObject<boolean>;
}

function resolveBehavior(event: Event): DragDropBehavior | null {
  if (isDropInsideChatDropTarget(event)) {
    return { mode: "chat-file", location: "chat-panel" };
  }
  if (hasVisibleChatDropTarget()) {
    return { mode: "chat-file", location: "chat-panel" };
  }
  if (isRepositoryDropPage()) {
    return { mode: "repository", location: "center" };
  }
  return null;
}

export function useBrowserDragDrop(options: UseBrowserDragDropOptions): void {
  const { t } = useTranslation();
  const {
    handleIdeFileDrop,
    handleBrowserFileDrop,
    setDroppedFolder,
    setIsDragging,
    setBehavior,
    dragDepthRef,
    appGridEditModeRef,
    workflowDragActiveRef,
    internalFileTreeDragRef,
  } = options;

  useEffect(() => {
    const isInternalDragFn = (e: Event) =>
      isInternalDrag(e, appGridEditModeRef, workflowDragActiveRef);

    const preventDefaults = createPreventDefaults(isInternalDragFn);

    const highlight = (e: Event) => {
      if (isInternalDragFn(e)) {
        if (e.type === "dragenter") {
          log("highlight:internal-skip", {
            type: e.type,
            transfer: summarizeDataTransfer((e as DragEvent).dataTransfer),
          });
        }
        return;
      }

      if (e.type === "dragenter") {
        dragDepthRef.current++;
        log("highlight:dragenter", {
          depth: dragDepthRef.current,
          transfer: summarizeDataTransfer((e as DragEvent).dataTransfer),
          insideChatDropTarget: isDropInsideChatDropTarget(e),
          isRepoPage: isRepositoryDropPage(),
        });
      }

      if (dragDepthRef.current > 0) {
        const nextBehavior = resolveBehavior(e);
        setBehavior(nextBehavior);
        setIsDragging(nextBehavior !== null);
      }
    };

    const unhighlight = (e: Event) => {
      if (isInternalDragFn(e)) return;

      dragDepthRef.current--;
      log("unhighlight:dragleave", { depth: dragDepthRef.current });

      if (dragDepthRef.current === 0) {
        setIsDragging(false);
        setBehavior(null);
      }
    };

    const handleDrop = (e: Event) => {
      const dragEvent = e as DragEvent;

      const rawTypes = dragEvent.dataTransfer?.types;
      const types = rawTypes ? Array.from(rawTypes) : [];

      const insideChatDropTarget = isDropInsideChatDropTarget(e);
      const dropTargetId = getChatDropTargetId(e);
      log("drop:received", {
        insideChatDropTarget,
        target: (e.target as Element | null)?.tagName ?? "<none>",
        targetClass:
          (e.target as Element | null)?.className?.toString().slice(0, 100) ??
          "",
        transfer: summarizeDataTransfer(dragEvent.dataTransfer),
      });

      // Internal file tree drag (via global variable — Tauri WebView often
      // strips custom MIME types at the window capture level).
      const internalFileData = consumeInternalFileTreeDragData();

      if (internalFileData) {
        log("drop:internal-file-tree", {
          insideChatDropTarget,
          payload: internalFileData.slice(0, 200),
        });
        e.preventDefault();
        e.stopPropagation();

        if (insideChatDropTarget) {
          let parsed: Record<string, unknown> | undefined;
          try {
            parsed = JSON.parse(internalFileData) as Record<string, unknown>;
          } catch (_parseError) {
            log("drop:internal-file-tree:parse-failed");
          }

          if (parsed && typeof parsed.path === "string" && parsed.path) {
            log("drop:handleIdeFileDrop", {
              source: "internal-file-tree",
              path: parsed.path,
              isFolder: parsed.type === "directory",
            });
            handleIdeFileDrop(
              parsed.path,
              typeof parsed.name === "string" ? parsed.name : undefined,
              parsed.type === "directory",
              dropTargetId
            );
          } else {
            log("drop:internal-file-tree:no-path", { parsed });
          }
        } else {
          log("drop:internal-file-tree:outside-chat-drop-target");
        }
        return;
      }

      // Internal file reference via dataTransfer MIME (backup path).
      if (types.includes("application/x-file-reference")) {
        log("drop:internal-file-reference", { insideChatDropTarget });
        e.preventDefault();
        e.stopPropagation();

        if (insideChatDropTarget) {
          const fileRefData = dragEvent.dataTransfer?.getData(
            "application/x-file-reference"
          );
          if (fileRefData) {
            let fileRef:
              | { path: string; name: string; type: string }
              | undefined;
            try {
              fileRef = JSON.parse(fileRefData) as {
                path: string;
                name: string;
                type: string;
              };
            } catch (_parseError) {
              log("drop:internal-file-reference:parse-failed");
            }
            if (fileRef?.path) {
              log("drop:handleIdeFileDrop", {
                source: "internal-file-reference",
                path: fileRef.path,
                isFolder: fileRef.type === "directory",
              });
              handleIdeFileDrop(
                fileRef.path,
                fileRef.name,
                fileRef.type === "directory",
                dropTargetId
              );
            } else {
              log("drop:internal-file-reference:no-path");
            }
          }
        }
        return;
      }

      if (isInternalDragFn(e)) {
        log("drop:internal-drag-skip");
        return;
      }

      preventDefaults(e);

      dragDepthRef.current = 0;
      setIsDragging(false);
      setBehavior(null);

      if (!dragEvent.dataTransfer?.items) {
        log("drop:no-items");
        return;
      }
      const items = Array.from(dragEvent.dataTransfer.items);

      // Repository drop (Start page folder → "add as repo" modal)
      if (isRepositoryDropPage() && !insideChatDropTarget) {
        for (const item of items) {
          if (item.kind !== "file") continue;
          const entry = item.webkitGetAsEntry?.();
          if (entry?.isDirectory) {
            log("drop:repository-mode", { name: entry.name });
            setDroppedFolder({
              path: entry.fullPath || `/${entry.name}`,
              name: entry.name,
            });
            return;
          }
        }
      }

      if (insideChatDropTarget) {
        handleFileDrop(dragEvent, items, dropTargetId);
      }
    };

    const handleFileDrop = (
      dragEvent: DragEvent,
      items: DataTransferItem[],
      dropTargetId?: string
    ) => {
      // Sync extraction first (OS file drops, VS Code URI drops)
      const extracted = extractFilePath(dragEvent.dataTransfer);
      log("fileDrop:extractSync", { extracted });
      if (extracted) {
        log("drop:handleIdeFileDrop", {
          source: "extractFilePath",
          path: extracted.filePath,
        });
        handleIdeFileDrop(
          extracted.filePath,
          extracted.fileName,
          undefined,
          dropTargetId
        );
        return;
      }

      // Async fallback for drag items that need promise-based reads
      const stringItems = items.filter((item) => item.kind === "string");
      if (stringItems.length > 0) {
        log("fileDrop:extractAsync:try", {
          stringItemCount: stringItems.length,
        });
        extractFilePathAsync(stringItems).then((result) => {
          log("fileDrop:extractAsync:done", { result });
          if (result) {
            log("drop:handleIdeFileDrop", {
              source: "extractFilePathAsync",
              path: result.filePath,
            });
            handleIdeFileDrop(
              result.filePath,
              result.fileName,
              undefined,
              dropTargetId
            );
          } else {
            Message.warning(t("dragDrop.couldNotExtractPathFromItem"));
          }
        });
        return;
      }

      // Direct File objects (OS native drop) — use filename + webkitRelativePath
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        const entry = item.webkitGetAsEntry?.();
        const isFolder = entry?.isDirectory ?? false;
        const fullPath =
          (file as File & { path?: string }).path ||
          entry?.fullPath ||
          file.name;
        log("drop:handleIdeFileDrop", {
          source: "file-object",
          path: fullPath,
          name: file.name,
          isFolder,
          hadNativePath: Boolean((file as File & { path?: string }).path),
        });
        if (fullPath && fullPath !== file.name) {
          handleIdeFileDrop(fullPath, file.name, isFolder, dropTargetId);
        } else {
          handleBrowserFileDrop(file, isFolder, dropTargetId);
        }
        return;
      }

      log("fileDrop:no-extractable-content", {
        itemKinds: items.map((it) => it.kind),
        types: dragEvent.dataTransfer
          ? Array.from(dragEvent.dataTransfer.types)
          : [],
      });
      Message.warning(t("dragDrop.couldNotExtractPathFromItem"));
    };

    // Track internal file tree drags via dataTransfer MIME hint
    const handleInternalDragStart = (event: DragEvent) => {
      const rawTypes = event.dataTransfer?.types;
      const types = rawTypes ? Array.from(rawTypes) : [];
      if (types.includes("application/x-file-reference")) {
        internalFileTreeDragRef.current = true;
      }
    };

    const handleInternalDragEnd = () => {
      if (internalFileTreeDragRef.current) {
        internalFileTreeDragRef.current = false;
      }
    };

    // ------------------------------------------------------------------
    // Event wiring
    //
    // We register preventDefaults and highlight/handleDrop on the SAME
    // capture phase on `document`. preventDefaults must NOT call
    // stopImmediatePropagation — doing so kills the handleDrop listener on
    // the same target+phase and was the root cause of chat drag-drop
    // silently breaking on workstation pages outside /code.
    // ------------------------------------------------------------------

    document.addEventListener("dragenter", preventDefaults, true);
    document.addEventListener("dragover", preventDefaults, true);
    document.addEventListener("dragleave", preventDefaults, false);
    document.addEventListener("drop", preventDefaults, true);

    document.addEventListener("dragenter", highlight as EventListener, true);
    document.addEventListener("dragover", highlight as EventListener, true);
    document.addEventListener("dragleave", unhighlight as EventListener, false);
    document.addEventListener("drop", handleDrop as EventListener, true);

    window.addEventListener("dragenter", preventDefaults, true);
    window.addEventListener("dragover", preventDefaults, true);
    window.addEventListener("drop", preventDefaults, true);

    document.addEventListener("dragstart", handleInternalDragStart, true);
    document.addEventListener("dragend", handleInternalDragEnd, true);

    return () => {
      document.removeEventListener("dragenter", preventDefaults, true);
      document.removeEventListener("dragover", preventDefaults, true);
      document.removeEventListener("dragleave", preventDefaults, false);
      document.removeEventListener("drop", preventDefaults, true);

      document.removeEventListener(
        "dragenter",
        highlight as EventListener,
        true
      );
      document.removeEventListener(
        "dragover",
        highlight as EventListener,
        true
      );
      document.removeEventListener(
        "dragleave",
        unhighlight as EventListener,
        false
      );
      document.removeEventListener("drop", handleDrop as EventListener, true);

      window.removeEventListener("dragenter", preventDefaults, true);
      window.removeEventListener("dragover", preventDefaults, true);
      window.removeEventListener("drop", preventDefaults, true);

      document.removeEventListener("dragstart", handleInternalDragStart, true);
      document.removeEventListener("dragend", handleInternalDragEnd, true);
    };
  }, [
    handleIdeFileDrop,
    handleBrowserFileDrop,
    setDroppedFolder,
    setIsDragging,
    setBehavior,
    dragDepthRef,
    appGridEditModeRef,
    workflowDragActiveRef,
    internalFileTreeDragRef,
    t,
  ]);
}
