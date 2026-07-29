import { useEffect, useRef, useState } from "react";

import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";
import {
  SESSION_TAB_DRAG_CANCEL_EVENT,
  SESSION_TAB_DRAG_END_EVENT,
  SESSION_TAB_DRAG_START_EVENT,
  type SessionReferenceOpen,
  type SessionTabDragEndDetail,
  type SessionTabDragStartDetail,
  getSessionReferenceFromDragDetail,
  isPointInsideElement,
} from "@src/shared/dnd/sessionTabDrag";

interface UseTeamInboxSessionDropTargetOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  disabled?: boolean;
  onDrop: (reference: SessionReferenceOpen) => void;
}

interface TeamInboxSessionDropTargetState {
  active: boolean;
  over: boolean;
}

/**
 * Copy-target for both native Session tabs and generic `session://` tabs.
 * Pointer sampling is attached only for the lifetime of an eligible drag and
 * coalesced to one hit-test per animation frame.
 */
export function useTeamInboxSessionDropTarget({
  containerRef,
  disabled = false,
  onDrop,
}: UseTeamInboxSessionDropTargetOptions): TeamInboxSessionDropTargetState {
  const onDropRef = useRef(onDrop);
  const disabledRef = useRef(disabled);
  const referenceRef = useRef<SessionReferenceOpen | null>(null);
  const overRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const stopTrackingRef = useRef<() => void>(() => undefined);
  const latestPointRef = useRef<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<TeamInboxSessionDropTargetState>({
    active: false,
    over: false,
  });

  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  useEffect(() => {
    const updateOver = (over: boolean) => {
      if (overRef.current === over) return;
      overRef.current = over;
      setState({ active: referenceRef.current != null, over });
    };

    const samplePointer = () => {
      frameRef.current = null;
      const point = latestPointRef.current;
      if (!point || !referenceRef.current || disabledRef.current) return;
      updateOver(isPointInsideElement(containerRef.current, point.x, point.y));
    };

    const handlePointerMove = (event: PointerEvent) => {
      latestPointRef.current = { x: event.clientX, y: event.clientY };
      if (frameRef.current != null) return;
      frameRef.current = window.requestAnimationFrame(samplePointer);
    };

    const stopTracking = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      latestPointRef.current = null;
      referenceRef.current = null;
      overRef.current = false;
      setState({ active: false, over: false });
    };
    stopTrackingRef.current = stopTracking;

    const startTracking = (reference: SessionReferenceOpen | null) => {
      stopTracking();
      if (!reference || disabledRef.current) return;
      referenceRef.current = reference;
      setState({ active: true, over: false });
      document.addEventListener("pointermove", handlePointerMove, {
        passive: true,
      });
    };

    const finishAt = (clientX?: number, clientY?: number) => {
      const reference = referenceRef.current;
      const inside =
        reference != null &&
        clientX != null &&
        clientY != null &&
        !disabledRef.current &&
        isPointInsideElement(containerRef.current, clientX, clientY);
      stopTracking();
      if (inside && reference) onDropRef.current(reference);
    };

    const handleSessionStart = (event: Event) => {
      const { transfer } = (event as CustomEvent<SessionTabDragStartDetail>)
        .detail;
      startTracking({
        sessionId: transfer.sessionId,
        title: transfer.title,
      });
    };
    const handleSessionEnd = (event: Event) => {
      const { clientX, clientY } = (
        event as CustomEvent<SessionTabDragEndDetail>
      ).detail;
      finishAt(clientX, clientY);
    };
    const handleReferenceStart = (event: Event) => {
      startTracking(
        getSessionReferenceFromDragDetail(
          (event as CustomEvent<TabDragEventDetail>).detail
        )
      );
    };
    const handleReferenceEnd = (event: Event) => {
      const { pointerX, pointerY } = (event as CustomEvent<TabDragEventDetail>)
        .detail;
      finishAt(pointerX, pointerY);
    };

    document.addEventListener(SESSION_TAB_DRAG_START_EVENT, handleSessionStart);
    document.addEventListener(SESSION_TAB_DRAG_END_EVENT, handleSessionEnd);
    document.addEventListener("tab-drag-start", handleReferenceStart);
    document.addEventListener("tab-drag-end", handleReferenceEnd);
    document.addEventListener(SESSION_TAB_DRAG_CANCEL_EVENT, stopTracking);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      if (frameRef.current != null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      latestPointRef.current = null;
      referenceRef.current = null;
      overRef.current = false;
      stopTrackingRef.current = () => undefined;
      document.removeEventListener(
        SESSION_TAB_DRAG_START_EVENT,
        handleSessionStart
      );
      document.removeEventListener(
        SESSION_TAB_DRAG_END_EVENT,
        handleSessionEnd
      );
      document.removeEventListener("tab-drag-start", handleReferenceStart);
      document.removeEventListener("tab-drag-end", handleReferenceEnd);
      document.removeEventListener(SESSION_TAB_DRAG_CANCEL_EVENT, stopTracking);
    };
  }, [containerRef]);

  useEffect(() => {
    if (!disabled) return;
    stopTrackingRef.current();
  }, [disabled]);

  return state;
}
