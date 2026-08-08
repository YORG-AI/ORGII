/**
 * Shared "a session was dropped here" surface.
 *
 * Two independent drag protocols name the same thing and both end with a
 * pointer release rather than an HTML5 drop:
 *
 *  - `SESSION_TAB_DRAG_*` — a native session TAB leaving the Chat Panel or
 *    Workstation tab strip. The detail carries the transfer directly.
 *  - `tab-drag-*` — the generic reference-pill drag every sidebar session row
 *    and Workstation tab emits. Only the `session://` pills are ours.
 *
 * Consumers get one `onDrop(reference, context)`; `context` reports which
 * protocol delivered it and where the pointer was released, so a surface that
 * overlaps another drop target (e.g. a channel whose composer already accepts
 * reference pills on its own) can decline the drops already handled for it.
 *
 * Pointer sampling is attached only for the lifetime of an eligible drag and
 * coalesced to one hit-test per animation frame.
 */
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
} from "./sessionTabDrag";

/** Which protocol delivered the drop, and where the pointer was released. */
export interface SessionDropContext {
  source: "session-tab" | "reference";
  clientX: number;
  clientY: number;
}

interface UseSessionDropTargetOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  disabled?: boolean;
  onDrop: (
    reference: SessionReferenceOpen,
    context: SessionDropContext
  ) => void;
}

interface SessionDropTargetState {
  active: boolean;
  over: boolean;
}

export function useSessionDropTarget({
  containerRef,
  disabled = false,
  onDrop,
}: UseSessionDropTargetOptions): SessionDropTargetState {
  const onDropRef = useRef(onDrop);
  const disabledRef = useRef(disabled);
  const referenceRef = useRef<SessionReferenceOpen | null>(null);
  const overRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const stopTrackingRef = useRef<() => void>(() => undefined);
  const latestPointRef = useRef<{ x: number; y: number } | null>(null);
  const [state, setState] = useState<SessionDropTargetState>({
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

    const finishAt = (
      source: SessionDropContext["source"],
      clientX?: number,
      clientY?: number
    ) => {
      const reference = referenceRef.current;
      const inside =
        reference != null &&
        clientX != null &&
        clientY != null &&
        !disabledRef.current &&
        isPointInsideElement(containerRef.current, clientX, clientY);
      stopTracking();
      if (inside && reference && clientX != null && clientY != null) {
        onDropRef.current(reference, { source, clientX, clientY });
      }
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
      finishAt("session-tab", clientX, clientY);
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
      finishAt("reference", pointerX, pointerY);
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
