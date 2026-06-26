/**
 * useDragDrop
 *
 * Handles drag and drop for the InputArea
 */
import { type DragEvent, type RefObject, useCallback } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import { capPillText, storePillText } from "@src/config/pillTokens";
import i18n from "@src/i18n";
import {
  consumeInternalFileTreeDragData,
  isInternalFileTreeDragActive,
} from "@src/shared/dnd/dragSideChannel";
import {
  type ReferenceDragPillData,
  clearReferenceDragData,
  getReferenceDragPillData,
  hasReferenceDragData,
} from "@src/shared/dnd/referenceDragData";

import type { DragDropHandlers } from "./types";

// Drag-over visual feedback — applied/removed via inline style
// so no SCSS file is needed. Inline styles beat class-based rules,
// making !important unnecessary.
function applyDragOverStyle(element: HTMLElement): void {
  element.style.border = "2px dashed var(--color-primary-6)";
  element.style.marginTop = "10px";
  element.style.borderRadius = "12px";
  element.style.backgroundColor =
    "color-mix(in srgb, var(--color-primary-6) 5%, transparent)";
}

function removeDragOverStyle(element: HTMLElement): void {
  element.style.border = "";
  element.style.marginTop = "";
  element.style.borderRadius = "";
  element.style.backgroundColor = "";
}

interface UseDragDropOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
}

function insertReferencePill(
  composerInputRef: RefObject<ComposerInputRef | null>,
  reference: ReferenceDragPillData
): void {
  if (!composerInputRef.current) return;
  storePillText(
    reference.pillPath,
    capPillText(JSON.stringify(reference.payload))
  );
  composerInputRef.current.insertFilePill(
    reference.pillPath,
    false,
    reference.iconType,
    reference.displayName
  );
  Message.success(
    i18n.t("toasts.addedAsContext", { name: reference.displayName })
  );
}

export function useDragDrop(options: UseDragDropOptions): DragDropHandlers {
  const { composerInputRef } = options;

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    const isInternalFileDrag = isInternalFileTreeDragActive();
    const isReferenceDrag = hasReferenceDragData();

    // Only handle internal file/reference drags - let others bubble to GlobalDragDrop
    if (!isInternalFileDrag && !isReferenceDrag) {
      return;
    }

    // Stop propagation to prevent GlobalDragDrop from handling it
    e.preventDefault();
    e.stopPropagation();
    if (
      e.nativeEvent &&
      typeof (e.nativeEvent as Event).stopImmediatePropagation === "function"
    ) {
      (e.nativeEvent as Event).stopImmediatePropagation();
    }

    // Add visual feedback
    applyDragOverStyle(e.currentTarget);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    const isInternalFileDrag = isInternalFileTreeDragActive();
    const isReferenceDrag = hasReferenceDragData();

    if (!isInternalFileDrag && !isReferenceDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    removeDragOverStyle(e.currentTarget);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const types = Array.from(e.dataTransfer.types);
      const internalFileTreeData = isInternalFileTreeDragActive()
        ? consumeInternalFileTreeDragData()
        : "";
      const isInternalFileDrag =
        Boolean(internalFileTreeData) ||
        types.includes("application/x-file-reference");
      const referenceDragData = getReferenceDragPillData(e.dataTransfer);
      const isReferenceDrag = Boolean(referenceDragData);

      // Only handle internal file/reference drags - let others bubble to GlobalDragDrop
      if (!isInternalFileDrag && !isReferenceDrag) {
        return;
      }

      // Stop propagation to prevent GlobalDragDrop from handling it
      e.preventDefault();
      e.stopPropagation();
      if (
        e.nativeEvent &&
        typeof (e.nativeEvent as Event).stopImmediatePropagation === "function"
      ) {
        (e.nativeEvent as Event).stopImmediatePropagation();
      }
      removeDragOverStyle(e.currentTarget);

      if (referenceDragData) {
        try {
          insertReferencePill(composerInputRef, referenceDragData);
        } finally {
          clearReferenceDragData(referenceDragData.type);
        }
        return;
      }

      // Get file reference data
      const fileReferenceData =
        internalFileTreeData ||
        e.dataTransfer.getData("application/x-file-reference");

      if (!fileReferenceData) {
        return;
      }

      let fileRef: { path: string; name: string; type: string };
      try {
        fileRef = JSON.parse(fileReferenceData);
      } catch (_parseError) {
        return;
      }

      if (!fileRef.path) {
        return;
      }

      // Insert file pill
      if (!composerInputRef.current) {
        return;
      }

      const isFolder = fileRef.type === "directory";
      composerInputRef.current.insertFilePill(
        fileRef.path,
        isFolder,
        isFolder ? "folder" : "file"
      );
      Message.success(i18n.t("toasts.addedAsContext", { name: fileRef.name }));
    },
    [composerInputRef]
  );

  return {
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}
