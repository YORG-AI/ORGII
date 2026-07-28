/**
 * useAppGridDrag
 *
 * Manages iOS-style long-press + pointer drag reordering for the AppGrid.
 * Uses the Pointer Events API instead of the HTML5 Drag API for better
 * Tauri compatibility (which suppresses native DnD in webviews).
 *
 * `draggedId` / `dragOverId` are plain state so CSS class changes trigger
 * re-renders. The `isDraggingRef` flag distinguishes a true drag from
 * a pointer-down that hasn't moved yet (preventing accidental reorders on
 * tap).
 */
import { useAtom } from "jotai";
import {
  type MutableRefObject,
  type PointerEvent,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";

import {
  appGridConfigAtom,
  appGridEditModeAtom,
} from "@src/store/ui/appGridAtom";

export interface UseAppGridDragReturn {
  draggedId: string | null;
  dragOverId: string | null;
  editMode: boolean;
  setEditMode: (value: boolean) => void;
  isDraggingRef: MutableRefObject<boolean>;
  gridContainerRef: RefObject<HTMLDivElement>;
  handleTouchStart: () => void;
  handleTouchEnd: () => void;
  handlePointerDown: (event: PointerEvent, appId: string) => void;
  handlePointerMove: (event: PointerEvent, appId: string) => void;
  handlePointerUp: (event: PointerEvent) => void;
  handlePointerCancel: () => void;
}

export function useAppGridDrag(): UseAppGridDragReturn {
  const [gridConfig, setGridConfig] = useAtom(appGridConfigAtom);
  const [editMode, setEditMode] = useAtom(appGridEditModeAtom);

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const gridContainerRef = useRef<HTMLDivElement>(
    null
  ) as RefObject<HTMLDivElement>;

  // Long-press to enter edit mode (500ms hold)
  const handleTouchStart = useCallback(() => {
    if (editMode) return;
    longPressTimer.current = setTimeout(() => {
      setEditMode(true);
    }, 500);
  }, [editMode, setEditMode]);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(
    (event: PointerEvent, appId: string) => {
      if (!editMode) return;
      dragStartPos.current = { x: event.clientX, y: event.clientY };
      isDraggingRef.current = false;
      setDraggedId(appId);
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
    },
    [editMode]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent, appId: string) => {
      if (!draggedId || draggedId !== appId) return;

      const dx = Math.abs(event.clientX - dragStartPos.current.x);
      const dy = Math.abs(event.clientY - dragStartPos.current.y);
      if (dx > 5 || dy > 5) {
        isDraggingRef.current = true;
      }
      if (!isDraggingRef.current) return;

      const elements = document.elementsFromPoint(event.clientX, event.clientY);
      let foundTarget: string | null = null;
      for (const element of elements) {
        const targetId = element.getAttribute("data-app-id");
        if (targetId && targetId !== draggedId) {
          foundTarget = targetId;
          break;
        }
      }

      if (foundTarget && foundTarget !== dragOverId) {
        setDragOverId(foundTarget);
        const newOrder = [...gridConfig.appOrder];
        const draggedIndex = newOrder.indexOf(draggedId);
        const targetIndex = newOrder.indexOf(foundTarget);
        if (draggedIndex !== -1 && targetIndex !== -1) {
          newOrder.splice(draggedIndex, 1);
          newOrder.splice(targetIndex, 0, draggedId);
          setGridConfig({ ...gridConfig, appOrder: newOrder });
        }
      } else if (!foundTarget && dragOverId) {
        setDragOverId(null);
      }
    },
    [draggedId, dragOverId, gridConfig, setGridConfig]
  );

  const handlePointerUp = useCallback((event: PointerEvent) => {
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    setDraggedId(null);
    setDragOverId(null);
    isDraggingRef.current = false;
  }, []);

  const handlePointerCancel = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
    isDraggingRef.current = false;
  }, []);

  return {
    draggedId,
    dragOverId,
    editMode,
    setEditMode,
    isDraggingRef,
    gridContainerRef,
    handleTouchStart,
    handleTouchEnd,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  };
}
