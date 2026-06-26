/**
 * useContainerDrag Hook
 *
 * Encapsulates container-level drag event handlers for InputArea.
 * Intercepts internal file-tree drags and WorkStation tab drags early
 * so they don't bubble to GlobalDragDrop.
 */
import React, { useCallback, useEffect, useState } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import {
  consumeWorkstationTabDragData,
  isInternalFileTreeDragActive,
  isWorkstationTabDragActive,
} from "@src/shared/dnd/dragSideChannel";
import { insertPillFromTabPayload } from "@src/shared/dnd/dropTargetUtils";
import { hasReferenceDragData } from "@src/shared/dnd/referenceDragData";
import { useTabDragEndToPill } from "@src/shared/dnd/useTabDragEndToPill";

import { reorderActiveRef } from "../components/QueuedMessages";
import { useTabDragHover } from "./useTabDragHover";

/**
 * Returns true while an external file (from the OS / Finder) is being dragged
 * over the chat panel. GlobalDragDrop sets `data-chat-file-dragging="true"` on
 * `document.body` during Tauri native drag events so we observe that attribute
 * via a MutationObserver rather than relying on unavailable HTML5 drag events.
 */
function useExternalFileDragOver(
  containerRef: React.RefObject<HTMLDivElement | null>
): boolean {
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const dragging = document.body.dataset.chatFileDragging === "true";
      // Only show the highlight when the container element is present in the
      // DOM and is (or contains) a visible chat drop target.
      const el = containerRef.current?.matches("[data-chat-drop-target]")
        ? containerRef.current
        : containerRef.current?.querySelector<HTMLElement>(
            "[data-chat-drop-target]"
          );
      setIsExternalDragOver(dragging && el !== null);
    });

    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-chat-file-dragging"],
    });

    return () => observer.disconnect();
  }, [containerRef]);

  return isExternalDragOver;
}

interface UseContainerDragOptions {
  handleDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  composerInputRef: React.RefObject<ComposerInputRef | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface UseContainerDragReturn {
  handleContainerDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleContainerDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleContainerDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  isDragOver: boolean;
}

export function useContainerDrag({
  handleDragOver,
  handleDragLeave,
  handleDrop,
  composerInputRef,
  containerRef,
}: UseContainerDragOptions): UseContainerDragReturn {
  const isTabDragOver = useTabDragHover(containerRef);
  const isExternalDragOver = useExternalFileDragOver(containerRef);
  const isDragOver = isTabDragOver || isExternalDragOver;
  // tab-drag-end listener — dnd-kit fires onDragEnd before the browser drop
  // event, so globals are already cleared by the time onDrop runs. Instead,
  // we listen for the custom event dispatched by useTabDrag and check whether
  // the pointer release landed inside our drop target using the pointer
  // coordinates forwarded in the event detail.
  useTabDragEndToPill(containerRef, composerInputRef);

  // Handle drag events at container level to catch internal file drags early
  const handleContainerDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (reorderActiveRef.current) return;

      // Use global flags - browser restricts dataTransfer.types during dragover
      const isInternalFileDrag = isInternalFileTreeDragActive();
      const isTabDrag = isWorkstationTabDragActive();
      const isReferenceDrag = hasReferenceDragData(
        Array.from(e.dataTransfer.types)
      );

      if (isInternalFileDrag || isTabDrag || isReferenceDrag) {
        e.preventDefault();
        e.stopPropagation();
        handleDragOver(e);
      }
      // Otherwise let it bubble to GlobalDragDrop
    },
    [handleDragOver]
  );

  const handleContainerDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (reorderActiveRef.current) return;

      const isInternalFileDrag = isInternalFileTreeDragActive();
      const isTabDrag = isWorkstationTabDragActive();
      const isReferenceDrag = hasReferenceDragData(
        Array.from(e.dataTransfer.types)
      );

      if (isInternalFileDrag || isTabDrag || isReferenceDrag) {
        e.preventDefault();
        e.stopPropagation();
        handleDragLeave(e);
      }
    },
    [handleDragLeave]
  );

  const handleContainerDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (reorderActiveRef.current) return;

      // Handle WorkStation tab drag-drop (dnd-kit pointer drag, no DataTransfer)
      const rawData = isWorkstationTabDragActive()
        ? consumeWorkstationTabDragData()
        : undefined;
      if (rawData) {
        e.preventDefault();
        e.stopPropagation();

        let data: Parameters<typeof insertPillFromTabPayload>[1];
        try {
          const parsed = JSON.parse(rawData) as unknown;
          if (!parsed || typeof parsed !== "object") return;
          data = parsed as Parameters<typeof insertPillFromTabPayload>[1];
        } catch {
          return;
        }

        insertPillFromTabPayload(composerInputRef, {
          ...data,
          pointerX: e.clientX,
          pointerY: e.clientY,
        });
        return;
      }

      // Can check dataTransfer.types during drop event
      const types = Array.from(e.dataTransfer.types);
      if (
        isInternalFileTreeDragActive() ||
        types.includes("application/x-file-reference") ||
        hasReferenceDragData(types)
      ) {
        // Prevent default and stop propagation before handling
        e.preventDefault();
        e.stopPropagation();
        handleDrop(e);
      }
    },
    [handleDrop, composerInputRef]
  );

  return {
    handleContainerDragOver,
    handleContainerDragLeave,
    handleContainerDrop,
    isDragOver,
  };
}
