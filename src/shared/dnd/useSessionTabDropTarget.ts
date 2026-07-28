import { useCallback, useEffect, useState } from "react";

import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import {
  SESSION_TAB_DRAG_CANCEL_EVENT,
  SESSION_TAB_DRAG_END_EVENT,
  SESSION_TAB_DRAG_START_EVENT,
  type SessionReferenceOpen,
  type SessionTabDragEndDetail,
  type SessionTabDragStartDetail,
  type SessionTabPlacement,
  type SessionTabTransfer,
  getSessionReferenceFromDragDetail,
  isPointInsideElement,
} from "./sessionTabDrag";

interface UseSessionTabDropTargetOptions {
  target: SessionTabPlacement;
  containerRef: React.RefObject<HTMLElement | null>;
  onDrop: (transfer: SessionTabTransfer) => boolean;
  onOpenSessionReference?: (reference: SessionReferenceOpen) => boolean;
}

/**
 * Bridges the two independent dnd-kit contexts used by the Chat Panel and
 * Workstation tab strips. The source publishes pointer coordinates; the
 * target owns hit-testing and the atomic state transfer.
 */
export function useSessionTabDropTarget({
  target,
  containerRef,
  onDrop,
  onOpenSessionReference,
}: UseSessionTabDropTargetOptions): boolean {
  const [eligibleDrag, setEligibleDrag] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const reset = useCallback(() => {
    setEligibleDrag(false);
    setIsDragOver(false);
  }, []);

  useEffect(() => {
    const handleStart = (event: Event) => {
      const { transfer } = (event as CustomEvent<SessionTabDragStartDetail>)
        .detail;
      if (transfer.source === target) {
        reset();
        return;
      }
      setEligibleDrag(true);
    };

    const handleReferenceStart = (event: Event) => {
      if (target !== "workstation" || !onOpenSessionReference) return;
      const detail = (event as CustomEvent<TabDragEventDetail>).detail;
      if (getSessionReferenceFromDragDetail(detail)) {
        setEligibleDrag(true);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!eligibleDrag) return;
      setIsDragOver(
        isPointInsideElement(containerRef.current, event.clientX, event.clientY)
      );
    };

    const handleEnd = (event: Event) => {
      const customEvent = event as CustomEvent<SessionTabDragEndDetail>;
      const { transfer, clientX, clientY } = customEvent.detail;
      const acceptsSource = transfer.source !== target;
      const isInside = isPointInsideElement(
        containerRef.current,
        clientX,
        clientY
      );
      if (acceptsSource && isInside && onDrop(transfer)) {
        customEvent.preventDefault();
      }
      reset();
    };

    const handleReferenceEnd = (event: Event) => {
      if (target !== "workstation" || !onOpenSessionReference) return;
      const detail = (event as CustomEvent<TabDragEventDetail>).detail;
      const reference = getSessionReferenceFromDragDetail(detail);
      if (!reference || detail.pointerX == null || detail.pointerY == null) {
        reset();
        return;
      }
      if (
        isPointInsideElement(
          containerRef.current,
          detail.pointerX,
          detail.pointerY
        )
      ) {
        onOpenSessionReference(reference);
      }
      reset();
    };

    document.addEventListener(SESSION_TAB_DRAG_START_EVENT, handleStart);
    document.addEventListener("tab-drag-start", handleReferenceStart);
    document.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    document.addEventListener(SESSION_TAB_DRAG_END_EVENT, handleEnd);
    document.addEventListener("tab-drag-end", handleReferenceEnd);
    document.addEventListener(SESSION_TAB_DRAG_CANCEL_EVENT, reset);
    return () => {
      document.removeEventListener(SESSION_TAB_DRAG_START_EVENT, handleStart);
      document.removeEventListener("tab-drag-start", handleReferenceStart);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener(SESSION_TAB_DRAG_END_EVENT, handleEnd);
      document.removeEventListener("tab-drag-end", handleReferenceEnd);
      document.removeEventListener(SESSION_TAB_DRAG_CANCEL_EVENT, reset);
    };
  }, [
    containerRef,
    eligibleDrag,
    onDrop,
    onOpenSessionReference,
    reset,
    target,
  ]);

  return isDragOver;
}
