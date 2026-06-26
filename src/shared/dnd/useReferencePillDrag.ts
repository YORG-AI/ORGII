import {
  type PointerEventHandler,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type {
  TabDragEventDetail,
  TabDragPillPayload,
} from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import {
  clearWorkstationTabDrag,
  setWorkstationTabDrag,
} from "./dragSideChannel";

const DRAG_THRESHOLD_PX = 6;

export interface ReferencePillDragState {
  isDragging: boolean;
  dragX: number;
  dragY: number;
  dragLabel: string;
}

interface ReferencePillDragOptions<TElement extends HTMLElement> {
  enabled?: boolean;
  tabId: string;
  getPayload: () => TabDragPillPayload | null | undefined;
  getEventDetail?: (payload: TabDragPillPayload) => Partial<TabDragEventDetail>;
  onPointerDown?: (event: ReactPointerEvent<TElement>) => void;
}

export function useReferencePillDrag<TElement extends HTMLElement>({
  enabled = true,
  tabId,
  getPayload,
  getEventDetail,
  onPointerDown,
}: ReferencePillDragOptions<TElement>): {
  dragHandlers: { onPointerDown?: PointerEventHandler<TElement> };
  dragState: ReferencePillDragState | null;
} {
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    thresholdMet: boolean;
  } | null>(null);
  const optionsRef = useRef({
    tabId,
    getPayload,
    getEventDetail,
    onPointerDown,
  });
  const [dragState, setDragState] = useState<ReferencePillDragState | null>(
    null
  );

  useLayoutEffect(() => {
    optionsRef.current = { tabId, getPayload, getEventDetail, onPointerDown };
  });

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<TElement>) => {
      if (!enabled || event.button !== 0) return;

      optionsRef.current.onPointerDown?.(event);
      const initialPayload = optionsRef.current.getPayload();
      if (!initialPayload) return;

      dragRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        thresholdMet: false,
      };

      const buildDetail = (payload: TabDragPillPayload) => ({
        tabId: optionsRef.current.tabId,
        pill: payload,
        ...optionsRef.current.getEventDetail?.(payload),
      });

      const onPointerMove = (moveEvent: PointerEvent) => {
        const state = dragRef.current;
        if (!state?.active) return;

        if (!state.thresholdMet) {
          const dx = moveEvent.clientX - state.startX;
          const dy = moveEvent.clientY - state.startY;
          if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;

          state.thresholdMet = true;
          setWorkstationTabDrag(initialPayload);
          document.dispatchEvent(
            new CustomEvent<TabDragEventDetail>("tab-drag-start", {
              detail: buildDetail(initialPayload),
            })
          );
          setDragState({
            isDragging: true,
            dragX: moveEvent.clientX,
            dragY: moveEvent.clientY,
            dragLabel: initialPayload.name ?? initialPayload.path,
          });
          return;
        }

        setDragState((prev) =>
          prev
            ? {
                ...prev,
                dragX: moveEvent.clientX,
                dragY: moveEvent.clientY,
              }
            : null
        );
      };

      const onPointerUp = (upEvent: PointerEvent) => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);

        const state = dragRef.current;
        dragRef.current = null;
        setDragState(null);
        clearWorkstationTabDrag();

        if (!state?.thresholdMet) return;

        const finalPayload = optionsRef.current.getPayload() ?? initialPayload;
        document.dispatchEvent(
          new CustomEvent<TabDragEventDetail>("tab-drag-end", {
            detail: {
              ...buildDetail(finalPayload),
              pointerX: upEvent.clientX,
              pointerY: upEvent.clientY,
            },
          })
        );
      };

      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    },
    [enabled]
  );

  useEffect(() => {
    return () => {
      if (dragRef.current?.thresholdMet) {
        clearWorkstationTabDrag();
      }
      dragRef.current = null;
      setDragState(null);
    };
  }, []);

  if (!enabled) {
    return { dragHandlers: {}, dragState: null };
  }

  return {
    dragHandlers: {
      onPointerDown: handlePointerDown,
    },
    dragState,
  };
}
