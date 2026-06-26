/**
 * useTabDrag Hook
 *
 * Handles all drag-and-drop logic for tabs including:
 * - Drag start/end events
 * - Insertion indicator positioning
 * - Tab reordering within a single pane
 */
import type {
  DragEndEvent,
  DragMoveEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearWorkstationTabDrag,
  setWorkstationTabDrag,
} from "@src/shared/dnd/dragSideChannel";

import { TAB_BAR_HEIGHT } from "../config";
import type { TabDragEventDetail, TabDragPillPayload } from "../tabDragTypes";
import type { WorkStationTab } from "../types";

/**
 * Drop line height; centered in the actual tab bar strip (the `.work-station-tab-bar`
 * row), not the full pane column — same vertical math as 32px pills in a 40px bar.
 */
const INSERTION_INDICATOR_HEIGHT = TAB_BAR_HEIGHT - 8;

// ============================================
// Types
// ============================================

export interface UseTabDragOptions {
  /** Current pane ID */
  paneId: string;
  /** List of tabs */
  tabs: WorkStationTab[];
  /** Callback when tabs are reordered */
  onTabReorder?: (startIndex: number, endIndex: number) => void;
}

export interface UseTabDragReturn {
  /** Currently dragging tab ID */
  draggingTabId: string | null;
  /** Currently dragging tab object */
  draggingTab: WorkStationTab | null;
  /** Handle drag start event */
  handleDragStart: (event: DragStartEvent) => void;
  /** Handle drag move event (no-op, tracking via pointermove) */
  handleDragMove: (event: DragMoveEvent) => void;
  /** Handle drag end event */
  handleDragEnd: (event: DragEndEvent) => void;
  /** Handle drag cancel event */
  handleDragCancel: () => void;
}

// ============================================
// Helpers
// ============================================

function readStringField(
  data: Record<string, unknown>,
  fieldName: string
): string | undefined {
  const value = data[fieldName];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getTabPillPayload(tab: WorkStationTab): TabDragPillPayload | null {
  if (tab.type === "file" || tab.type === "git-diff") {
    const filePath = readStringField(tab.data, "filePath");
    if (!filePath) return null;
    return {
      path: filePath,
      name: tab.title,
      iconType: "file",
      tabType: tab.type,
    };
  }

  if (tab.type === "directory") {
    const directoryPath = readStringField(tab.data, "directoryPath");
    if (!directoryPath) return null;
    return {
      path: directoryPath,
      name: tab.title,
      iconType: "folder",
      isFolder: true,
      tabType: tab.type,
    };
  }

  if (tab.type === "project-workitems") {
    const projectSlug = readStringField(tab.data, "projectSlug");
    const projectId = readStringField(tab.data, "projectId");
    const projectPath = projectSlug ?? projectId;
    if (!projectPath) return null;
    return {
      path: projectPath,
      name: readStringField(tab.data, "projectName") ?? tab.title,
      iconType: "project",
      tabType: tab.type,
    };
  }

  if (tab.type === "project-dashboard") {
    return {
      path: readStringField(tab.data, "orgId") ?? "workspace",
      name: tab.title,
      iconType: "project",
      tabType: tab.type,
    };
  }

  if (tab.type === "project-work-items") {
    const orgScope = readStringField(tab.data, "orgScope");
    const orgId = readStringField(tab.data, "orgId");
    return {
      path: orgId ? `org/${orgId}` : (orgScope ?? "workspace"),
      name: tab.title,
      iconType: "project",
      tabType: tab.type,
    };
  }

  if (tab.type === "workItem-detail") {
    const workItemId = readStringField(tab.data, "workItemId");
    const projectSlug = readStringField(tab.data, "projectSlug");
    const workItemPath =
      projectSlug && workItemId ? `${projectSlug}/${workItemId}` : workItemId;
    if (!workItemPath) return null;
    return {
      path: workItemPath,
      name: readStringField(tab.data, "workItemName") ?? tab.title,
      iconType: "workitem",
      tabType: tab.type,
    };
  }

  return null;
}

// ============================================
// Hook Implementation
// ============================================

export function useTabDrag({
  paneId,
  tabs,
  onTabReorder,
}: UseTabDragOptions): UseTabDragReturn {
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);

  const lastPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMoveHandlerRef = useRef<((e: PointerEvent) => void) | null>(
    null
  );

  const draggingTab = useMemo(
    () =>
      draggingTabId
        ? (tabs.find((tab) => tab.id === draggingTabId) ?? null)
        : null,
    [draggingTabId, tabs]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tabId = event.active.id as string;
      setDraggingTabId(tabId);

      if (pointerMoveHandlerRef.current) {
        window.removeEventListener(
          "pointermove",
          pointerMoveHandlerRef.current
        );
      }
      const trackPointer = (e: PointerEvent) => {
        lastPointerPositionRef.current = { x: e.clientX, y: e.clientY };
      };
      pointerMoveHandlerRef.current = trackPointer;
      window.addEventListener("pointermove", trackPointer, { passive: true });

      const foundTab = tabs.find((tab) => tab.id === tabId);
      const pill = foundTab ? getTabPillPayload(foundTab) : null;
      const filePath =
        pill?.iconType === "file" || pill?.iconType === "folder"
          ? pill.path
          : undefined;

      if (pill) {
        setWorkstationTabDrag(pill);
      }

      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-start", {
          detail: { tabId, filePath, pill: pill ?? undefined },
        })
      );
    },
    [tabs]
  );

  // Track pointer position during drag move, and show insertion indicator
  useEffect(() => {
    if (!draggingTabId) {
      document.querySelectorAll(".drop-target-highlight").forEach((el) => {
        el.classList.remove("drop-target-highlight");
      });
      document.querySelector(".tab-insertion-indicator")?.remove();
      return;
    }

    let indicator = document.querySelector(
      ".tab-insertion-indicator"
    ) as HTMLDivElement | null;
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.className = "tab-insertion-indicator";
      indicator.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        width: 2px;
        height: ${INSERTION_INDICATOR_HEIGHT}px;
        background: var(--color-primary-6);
        border-radius: 1px;
        z-index: 10000;
        pointer-events: none;
        display: none;
        box-shadow: 0 0 4px color-mix(in srgb, var(--color-primary-6) 50%, transparent);
        will-change: transform;
        contain: layout style;
      `;
      document.body.appendChild(indicator);
    }

    const allPanes = Array.from(
      document.querySelectorAll("[data-pane-id]")
    ) as HTMLElement[];

    const currentPane = allPanes.find((pane) => pane.dataset.paneId === paneId);

    let lastIndicatorX = -1;
    let rafId: number | null = null;
    let lastX = 0;
    let lastY = 0;

    const updateIndicator = () => {
      rafId = null;
      if (!indicator) return;

      // Re-read layout on every frame so stale cached bounds don't cause
      // wrong indicator positions after the tab strip has scrolled or the
      // panel has been resized since drag-start.
      let currentPaneBounds: DOMRect | null = null;
      let currentTabBarBounds: DOMRect | null = null;
      let currentPaneTabBounds: Array<{
        left: number;
        right: number;
        midpoint: number;
        id: string;
      }> = [];
      if (currentPane) {
        currentPaneBounds = currentPane.getBoundingClientRect();
        const currentTabBar = currentPane.querySelector(
          ".work-station-tab-bar"
        );
        currentTabBarBounds = currentTabBar
          ? currentTabBar.getBoundingClientRect()
          : null;
        const currentTabs = currentPane.querySelectorAll("[data-tab-id]");
        currentPaneTabBounds = Array.from(currentTabs).map((tab) => {
          const tabEl = tab as HTMLElement;
          const rect = tabEl.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            midpoint: rect.left + rect.width / 2,
            id: tabEl.dataset.tabId || "",
          };
        });
      }

      const overCurrent =
        currentPaneBounds &&
        lastX >= currentPaneBounds.left &&
        lastX <= currentPaneBounds.right &&
        lastY >= currentPaneBounds.top &&
        lastY <= currentPaneBounds.bottom;

      if (!overCurrent) {
        indicator.style.display = "none";
        return;
      }

      let indicatorX = 0;
      const tabBounds = currentPaneTabBounds;
      const paneBounds = currentPaneBounds;
      if (!paneBounds) return;

      const tabStripBounds = currentTabBarBounds;
      const top = tabStripBounds?.top ?? paneBounds.top;
      const stripH = tabStripBounds?.height ?? TAB_BAR_HEIGHT;
      const lineH = Math.min(
        INSERTION_INDICATOR_HEIGHT,
        Math.max(1, stripH - 2)
      );
      const indicatorY = top + (stripH - lineH) / 2;
      if (indicator) {
        indicator.style.height = `${lineH}px`;
      }

      if (tabBounds.length > 0) {
        let foundPosition = false;

        for (let tabIdx = 0; tabIdx < tabBounds.length; tabIdx++) {
          const tabBound = tabBounds[tabIdx];
          if (tabBound.id === draggingTabId) {
            continue;
          }
          if (lastX < tabBound.midpoint) {
            indicatorX = tabBound.left - 1;
            foundPosition = true;
            break;
          }
        }

        if (!foundPosition) {
          const lastTab = tabBounds[tabBounds.length - 1];
          if (lastTab) {
            indicatorX = lastTab.right - 1;
          }
        }
      } else {
        indicatorX = paneBounds.left + 8;
      }

      if (Math.abs(indicatorX - lastIndicatorX) > 1) {
        lastIndicatorX = indicatorX;
        indicator.style.transform = `translate3d(${indicatorX}px, ${indicatorY}px, 0)`;
        indicator.style.display = "block";
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      lastX = event.clientX;
      lastY = event.clientY;

      if (rafId === null) {
        rafId = requestAnimationFrame(updateIndicator);
      }
    };

    document.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      indicator?.remove();
    };
  }, [draggingTabId, paneId]);

  const handleDragMove = useCallback((_event: DragMoveEvent) => {
    // Position tracking handled by pointermove listener above
  }, []);

  const removePointerTracker = useCallback(() => {
    if (pointerMoveHandlerRef.current) {
      window.removeEventListener("pointermove", pointerMoveHandlerRef.current);
      pointerMoveHandlerRef.current = null;
    }
  }, []);

  const clearTabDragGlobals = useCallback(() => {
    clearWorkstationTabDrag();
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const tabId = active.id as string;

      const foundTab = tabs.find((tab) => tab.id === tabId);
      const pill = foundTab ? getTabPillPayload(foundTab) : null;
      const filePath =
        pill?.iconType === "file" || pill?.iconType === "folder"
          ? pill.path
          : undefined;
      const type = pill?.isFolder ? "directory" : "file";

      setDraggingTabId(null);
      clearTabDragGlobals();
      removePointerTracker();

      const pointerX = lastPointerPositionRef.current?.x;
      const pointerY = lastPointerPositionRef.current?.y;
      lastPointerPositionRef.current = null;

      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-end", {
          detail: {
            tabId,
            filePath,
            name: pill?.name ?? foundTab?.title,
            type,
            pill: pill ?? undefined,
            pointerX,
            pointerY,
          },
        })
      );

      if (over && active.id !== over.id && onTabReorder) {
        const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
        const newIndex = tabs.findIndex((tab) => tab.id === over.id);

        if (oldIndex !== -1 && newIndex !== -1) {
          onTabReorder(oldIndex, newIndex);
        }
      }
    },
    [tabs, onTabReorder, clearTabDragGlobals, removePointerTracker]
  );

  const handleDragCancel = useCallback(() => {
    setDraggingTabId(null);
    clearTabDragGlobals();
    removePointerTracker();
    lastPointerPositionRef.current = null;
  }, [clearTabDragGlobals, removePointerTracker]);

  return {
    draggingTabId,
    draggingTab,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
}

export default useTabDrag;
