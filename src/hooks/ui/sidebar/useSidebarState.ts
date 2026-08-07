/**
 * useSidebarState Hook
 *
 * Manages the single global sidebar: width, collapse, drag-to-resize,
 * and preference persistence. Width is user-driven only — the sidebar
 * no longer auto-collapses or re-clamps on window resize. Narrow
 * viewports are handled by `useNarrowChatFocus`, which maximizes the
 * chat panel instead of squeezing the sidebar.
 *
 * Drag listeners are attached synchronously in handleMouseDown (not via
 * useEffect) so there is zero render-cycle delay. This also avoids
 * conflicts when multiple SidebarBase instances mount the same hook.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";

import {
  COLLAPSED_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
  sidebarDraggingAtom,
  sidebarWidthAtom,
} from "@src/store/ui/sidebarAtom";

export interface UseSidebarStateReturn {
  /** Current sidebar width in pixels (0 if collapsed) */
  width: number;
  /** Persisted expanded width, even while the sidebar is collapsed. */
  expandedWidth: number;
  /** Whether sidebar is collapsed */
  isCollapsed: boolean;
  /** Whether currently dragging */
  isDragging: boolean;
  /** Mouse down handler for drag handle */
  handleMouseDown: (e: ReactMouseEvent) => void;
  /** Toggle collapse state */
  toggleCollapse: () => void;
  /** Expand sidebar (uncollapse) */
  expand: () => void;
  /** Collapse sidebar */
  collapse: () => void;
  /** Set width directly */
  setWidth: (width: number) => void;
}

export function useSidebarState(): UseSidebarStateReturn {
  // Sidebar width is user-driven only: we no longer auto-shrink the max
  // width on window resize, so the user's chosen width stays stable
  // until they drag the handle themselves. See `useNarrowChatFocus` for
  // the narrow-viewport adaptation — it covers the missing chrome by
  // maximizing the chat panel instead of squeezing the sidebar.
  const maxWidth = MAX_SIDEBAR_WIDTH;

  // Global state — split read/write for isDragging so setter is stable
  const [globalWidth, setGlobalWidth] = useAtom(sidebarWidthAtom);
  const [isCollapsed, setGlobalCollapsed] = useAtom(sidebarCollapsedAtom);
  const isDragging = useAtomValue(sidebarDraggingAtom);
  const setIsDragging = useSetAtom(sidebarDraggingAtom);

  // Refs for drag performance
  const pendingWidthRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const width = isCollapsed ? COLLAPSED_SIDEBAR_WIDTH : globalWidth;

  // ── Helpers ──────────────────────────────────────────────────────────

  const updateGlobal = useCallback(
    (updates: Partial<{ width: number; collapsed: boolean }>) => {
      if (updates.width !== undefined) {
        setGlobalWidth(updates.width);
      }
      if (updates.collapsed !== undefined) {
        setGlobalCollapsed(updates.collapsed);
      }
    },
    [setGlobalWidth, setGlobalCollapsed]
  );

  // Keep refs current so closures inside handleMouseDown always read
  // the latest values without re-creating the outer callback.
  const maxWidthRef = useRef(maxWidth);
  useEffect(() => {
    maxWidthRef.current = maxWidth;
  }, [maxWidth]);

  const updateGlobalRef = useRef(updateGlobal);
  useEffect(() => {
    updateGlobalRef.current = updateGlobal;
  }, [updateGlobal]);

  // ── Drag handler (synchronous listener attach) ─────────────────────

  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (isCollapsed) return;
      if (e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      setIsDragging(true);
      pendingWidthRef.current = null;

      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEvent: globalThis.MouseEvent) => {
        moveEvent.preventDefault();
        const currentMax = maxWidthRef.current;
        const newWidth = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(currentMax, moveEvent.clientX)
        );
        if (pendingWidthRef.current === newWidth) return;
        pendingWidthRef.current = newWidth;

        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          if (pendingWidthRef.current !== null) {
            updateGlobalRef.current({ width: pendingWidthRef.current });
          }
        });
      };

      const cleanup = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        dragCleanupRef.current = null;
      };

      const onMouseUp = () => {
        if (pendingWidthRef.current !== null) {
          updateGlobalRef.current({ width: pendingWidthRef.current });
          pendingWidthRef.current = null;
        }
        cleanup();
        setIsDragging(false);
      };

      dragCleanupRef.current = cleanup;
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isCollapsed, setIsDragging]
  );

  // ── Collapse / expand ───────────────────────────────────────────────

  const toggleCollapse = useCallback(() => {
    requestAnimationFrame(() => {
      updateGlobal({ collapsed: !isCollapsed });
    });
  }, [isCollapsed, updateGlobal]);

  const expand = useCallback(() => {
    requestAnimationFrame(() => updateGlobal({ collapsed: false }));
  }, [updateGlobal]);

  const collapse = useCallback(() => {
    requestAnimationFrame(() => updateGlobal({ collapsed: true }));
  }, [updateGlobal]);

  const setWidth = useCallback(
    (newWidth: number) => {
      const constrained = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(maxWidth, newWidth)
      );
      updateGlobal({ width: constrained });
    },
    [maxWidth, updateGlobal]
  );

  // ── Cleanup on unmount / window blur ───────────────────────────────

  useEffect(() => {
    const handleWindowBlur = () => {
      dragCleanupRef.current?.();
      setIsDragging(false);
    };

    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      dragCleanupRef.current?.();
    };
  }, [setIsDragging]);

  return {
    width,
    expandedWidth: globalWidth,
    isCollapsed,
    isDragging,
    handleMouseDown,
    toggleCollapse,
    expand,
    collapse,
    setWidth,
  };
}

export default useSidebarState;
