import { useCallback, useEffect, useRef, useState } from "react";

import type { DomSelectionRect } from "@src/features/DomSelection/types";

import {
  type CanvasDesignSelection,
  captureCanvasElement,
  captureCanvasRegion,
  elementFromComposedPath,
} from "./canvasDomCapture";

const DRAG_THRESHOLD = 5;

interface Point {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  start: Point;
  latest: Point;
  target: HTMLElement;
}

export interface CanvasDesignInspectorState {
  hovered: CanvasDesignSelection | null;
  selected: CanvasDesignSelection | null;
  marquee: DomSelectionRect | null;
  rootRect: DomSelectionRect;
  rootSize: { width: number; height: number };
  promptOpen: boolean;
}

export interface UseCanvasDesignInspectorResult extends CanvasDesignInspectorState {
  clearSelection: () => void;
  closePrompt: () => void;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function regionFromPoints(a: Point, b: Point): DomSelectionRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function localizeRect(
  rect: DomSelectionRect,
  rootRect: DOMRect
): DomSelectionRect {
  return {
    x: rect.x - rootRect.left,
    y: rect.y - rootRect.top,
    width: rect.width,
    height: rect.height,
  };
}

function viewportRect(rect: DOMRect): DomSelectionRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function localizeSelection(
  selection: CanvasDesignSelection,
  rootRect: DOMRect
): CanvasDesignSelection {
  return {
    ...selection,
    rect: localizeRect(selection.rect, rootRect),
    elementInfo: {
      ...selection.elementInfo,
      rect: localizeRect(selection.elementInfo.rect, rootRect),
    },
    targets: selection.targets?.map((target) => ({
      ...target,
      rect: localizeRect(target.rect, rootRect),
    })),
  };
}

export function useCanvasDesignInspector(
  rootRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean
): UseCanvasDesignInspectorResult {
  const [state, setState] = useState<CanvasDesignInspectorState>({
    hovered: null,
    selected: null,
    marquee: null,
    rootRect: { x: 0, y: 0, width: 0, height: 0 },
    rootSize: { width: 0, height: 0 },
    promptOpen: false,
  });
  const hoveredElementRef = useRef<HTMLElement | null>(null);
  const selectedElementRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const hasSelectionRef = useRef(false);

  const clearSelection = useCallback(() => {
    selectedElementRef.current = null;
    hasSelectionRef.current = false;
    setState((current) => ({
      ...current,
      selected: null,
      marquee: null,
      promptOpen: false,
    }));
  }, []);

  const closePrompt = useCallback(() => {
    setState((current) => ({ ...current, promptOpen: false }));
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root) {
      hoveredElementRef.current = null;
      selectedElementRef.current = null;
      dragRef.current = null;
      hasSelectionRef.current = false;
      return;
    }
    const activeRoot = root;

    let frameId: number | null = null;
    const resizeObserver = new ResizeObserver(() => scheduleGeometryRefresh());

    const refreshGeometry = () => {
      frameId = null;
      const rootRect = activeRoot.getBoundingClientRect();
      const hoveredElement = hoveredElementRef.current;
      const selectedElement = selectedElementRef.current;
      setState((current) => {
        // Geometry-only refresh: this runs per animation frame during
        // scroll/hover, so it must not reserialize innerHTML or force layout
        // through innerText the way a full `captureCanvasElement` does. The
        // full capture happens only when a selection is finalized.
        const refreshSelectionRect = (
          selection: CanvasDesignSelection,
          element: HTMLElement
        ) => {
          const fresh = viewportRect(element.getBoundingClientRect());
          return localizeSelection(
            {
              ...selection,
              rect: fresh,
              elementInfo: {
                ...selection.elementInfo,
                rect: fresh,
              },
            },
            rootRect
          );
        };
        const hovered =
          hoveredElement?.isConnected && current.hovered
            ? refreshSelectionRect(current.hovered, hoveredElement)
            : null;
        const selected =
          selectedElement?.isConnected && current.selected
            ? refreshSelectionRect(current.selected, selectedElement)
            : current.selected?.kind === "region"
              ? current.selected
              : null;
        return {
          ...current,
          hovered,
          selected,
          rootRect: viewportRect(rootRect),
          rootSize: { width: rootRect.width, height: rootRect.height },
        };
      });
    };

    function scheduleGeometryRefresh() {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(refreshGeometry);
    }

    const clearHover = () => {
      hoveredElementRef.current = null;
      setState((current) =>
        current.hovered ? { ...current, hovered: null } : current
      );
    };

    const updateHover = (event: PointerEvent) => {
      if (dragRef.current) return;
      const element = elementFromComposedPath(event, root);
      if (!element) {
        // Pointer moved onto empty root background (or design UI): drop the
        // hover box instead of leaving it stuck on the last element.
        clearHover();
        return;
      }
      if (element === hoveredElementRef.current) return;
      hoveredElementRef.current = element;
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      resizeObserver.observe(element);
      if (selectedElementRef.current) {
        resizeObserver.observe(selectedElementRef.current);
      }
      const rootRect = activeRoot.getBoundingClientRect();
      const hovered = localizeSelection(
        captureCanvasElement(element, { includePreview: false }),
        rootRect
      );
      setState((current) => ({
        ...current,
        hovered,
        rootRect: viewportRect(rootRect),
        rootSize: { width: rootRect.width, height: rootRect.height },
      }));
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = elementFromComposedPath(event, root);
      if (!target) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const point = { x: event.clientX, y: event.clientY };
      dragRef.current = {
        pointerId: event.pointerId,
        start: point,
        latest: point,
        target,
      };
      setState((current) => ({ ...current, marquee: null }));
      window.addEventListener("pointermove", handleDragMove, true);
      window.addEventListener("pointerup", finishPointer, true);
      window.addEventListener("pointercancel", cancelPointer, true);
    };

    const releaseDragListeners = () => {
      window.removeEventListener("pointermove", handleDragMove, true);
      window.removeEventListener("pointerup", finishPointer, true);
      window.removeEventListener("pointercancel", cancelPointer, true);
    };

    const handleRootPointerMove = (event: PointerEvent) => {
      if (dragRef.current) return;
      updateHover(event);
    };

    function handleDragMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      drag.latest = { x: event.clientX, y: event.clientY };
      if (distance(drag.start, drag.latest) < DRAG_THRESHOLD) return;
      const rootRect = activeRoot.getBoundingClientRect();
      const region = localizeRect(
        regionFromPoints(drag.start, drag.latest),
        rootRect
      );
      setState((current) => ({ ...current, marquee: region }));
    }

    function finishPointer(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const finish = { x: event.clientX, y: event.clientY };
      const rootRect = activeRoot.getBoundingClientRect();
      const isRegion = distance(drag.start, finish) >= DRAG_THRESHOLD;
      let selected: CanvasDesignSelection | null = null;
      try {
        if (isRegion) {
          const viewportRegion = regionFromPoints(drag.start, finish);
          selected = captureCanvasRegion(activeRoot, viewportRegion);
        } else {
          selected = captureCanvasElement(drag.target);
        }
      } catch {
        // A visual preview is enrichment, not a selection gate. Some Canvas
        // trees expose styles that WebKit cannot serialize; keep the editor
        // reachable with the already-inspectable DOM metadata in that case.
        if (!isRegion) {
          try {
            selected = captureCanvasElement(drag.target, {
              includePreview: false,
            });
          } catch {
            selected = null;
          }
        }
      }
      if (selected) selected = localizeSelection(selected, rootRect);
      dragRef.current = null;
      releaseDragListeners();
      if (!selected) {
        setState((current) => ({ ...current, marquee: null }));
        return;
      }
      selectedElementRef.current = isRegion ? null : drag.target;
      hasSelectionRef.current = true;
      setState((current) => ({
        ...current,
        selected,
        hovered: selected,
        marquee: null,
        promptOpen: true,
        rootRect: viewportRect(rootRect),
        rootSize: { width: rootRect.width, height: rootRect.height },
      }));
    }

    const blockClick = (event: MouseEvent) => {
      if (!elementFromComposedPath(event, root)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    function cancelPointer(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragRef.current = null;
      releaseDragListeners();
      setState((current) => ({ ...current, marquee: null }));
    }

    const cancelActiveDrag = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      releaseDragListeners();
      setState((current) => ({ ...current, marquee: null }));
    };

    // Escape is handled only while the inspector has something to clear
    // (drag, selection, or hover). Otherwise the event passes through — a
    // window-level capture handler that always swallowed Escape used to kill
    // dialogs' own Escape handling app-wide while design mode was on.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const dragActive = dragRef.current !== null;
      const hasSelection = hasSelectionRef.current;
      const hasHover = hoveredElementRef.current !== null;
      if (!dragActive && !hasSelection && !hasHover) return;
      event.preventDefault();
      event.stopPropagation();
      if (dragActive) {
        cancelActiveDrag();
        return;
      }
      clearHover();
      if (hasSelection) clearSelection();
    };

    const handleRootPointerLeave = () => {
      if (dragRef.current) return;
      clearHover();
    };

    const handleScrollOrResize = () => scheduleGeometryRefresh();
    const initialRect = root.getBoundingClientRect();
    setState((current) => ({
      ...current,
      rootRect: viewportRect(initialRect),
      rootSize: { width: initialRect.width, height: initialRect.height },
    }));
    resizeObserver.observe(root);
    root.addEventListener("pointerdown", handlePointerDown, true);
    root.addEventListener("pointermove", handleRootPointerMove, true);
    root.addEventListener("pointerleave", handleRootPointerLeave);
    root.addEventListener("click", blockClick, true);
    root.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      root.removeEventListener("pointerdown", handlePointerDown, true);
      root.removeEventListener("pointermove", handleRootPointerMove, true);
      root.removeEventListener("pointerleave", handleRootPointerLeave);
      releaseDragListeners();
      root.removeEventListener("click", blockClick, true);
      root.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      window.removeEventListener("keydown", handleKeyDown, true);
      resizeObserver.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      hoveredElementRef.current = null;
      selectedElementRef.current = null;
      dragRef.current = null;
      hasSelectionRef.current = false;
    };
  }, [clearSelection, enabled, rootRef]);

  return { ...state, clearSelection, closePrompt };
}
