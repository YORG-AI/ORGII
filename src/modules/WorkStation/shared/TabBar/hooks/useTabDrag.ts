/**
 * useTabDrag Hook
 *
 * Handles all drag-and-drop logic for tabs including:
 * - Drag start/end events
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
import {
  type SessionTabTransfer,
  dispatchSessionTabDragCancel,
  dispatchSessionTabDragEnd,
  dispatchSessionTabDragStart,
} from "@src/shared/dnd/sessionTabDrag";

import type { TabDragEventDetail, TabDragPillPayload } from "../tabDragTypes";
import type { WorkStationTab } from "../types";

// ============================================
// Types
// ============================================

export interface UseTabDragOptions {
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

function getSessionTabTransfer(
  tab: WorkStationTab | undefined
): SessionTabTransfer | null {
  if (tab?.type !== "chat-session") return null;
  const sessionId = readStringField(tab.data, "sessionId");
  if (!sessionId) return null;
  return {
    source: "workstation",
    sourceTabId: tab.id,
    sessionId,
    title: tab.title,
  };
}

// ============================================
// Hook Implementation
// ============================================

export function useTabDrag({
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

      const activatorEvent = event.activatorEvent;
      if (
        "clientX" in activatorEvent &&
        "clientY" in activatorEvent &&
        typeof activatorEvent.clientX === "number" &&
        typeof activatorEvent.clientY === "number"
      ) {
        lastPointerPositionRef.current = {
          x: activatorEvent.clientX,
          y: activatorEvent.clientY,
        };
      }

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
      const sessionTransfer = getSessionTabTransfer(foundTab);
      if (sessionTransfer) {
        dispatchSessionTabDragStart(sessionTransfer);
      }

      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-start", {
          detail: { tabId, filePath, pill: pill ?? undefined },
        })
      );
    },
    [tabs]
  );

  const handleDragMove = useCallback((_event: DragMoveEvent) => {
    // Position tracking is owned by the drag-start pointer listener.
  }, []);

  const removePointerTracker = useCallback(() => {
    if (pointerMoveHandlerRef.current) {
      window.removeEventListener("pointermove", pointerMoveHandlerRef.current);
      pointerMoveHandlerRef.current = null;
    }
  }, []);

  useEffect(() => removePointerTracker, [removePointerTracker]);

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

      const sessionTransfer = getSessionTabTransfer(foundTab);
      const movedToChatPanel =
        sessionTransfer && pointerX !== undefined && pointerY !== undefined
          ? dispatchSessionTabDragEnd(sessionTransfer, pointerX, pointerY)
          : false;
      if (
        sessionTransfer &&
        (pointerX === undefined || pointerY === undefined)
      ) {
        dispatchSessionTabDragCancel();
      }

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

      if (!movedToChatPanel && over && active.id !== over.id && onTabReorder) {
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
    const tabId = draggingTabId;

    setDraggingTabId(null);
    clearTabDragGlobals();
    dispatchSessionTabDragCancel();
    removePointerTracker();
    lastPointerPositionRef.current = null;

    // handleDragEnd always fires "tab-drag-end" so drop targets (e.g.
    // useSessionReferenceDropTarget) can drop the pointermove listener they
    // attached on "tab-drag-start". An Escape-cancelled drag skips
    // handleDragEnd entirely, so without this it never fires and the
    // listener is stranded on every mounted drop target until an unrelated
    // drag happens to end near it. No drop point is known here (the drag
    // was cancelled, not released), so this carries no pointerX/pointerY —
    // listeners must treat their absence as "nothing to insert".
    if (tabId) {
      const foundTab = tabs.find((tab) => tab.id === tabId);
      const pill = foundTab ? getTabPillPayload(foundTab) : null;
      const filePath =
        pill?.iconType === "file" || pill?.iconType === "folder"
          ? pill.path
          : undefined;
      const type = pill?.isFolder ? "directory" : "file";

      document.dispatchEvent(
        new CustomEvent<TabDragEventDetail>("tab-drag-end", {
          detail: {
            tabId,
            filePath,
            name: pill?.name ?? foundTab?.title,
            type,
            pill: pill ?? undefined,
          },
        })
      );
    }
  }, [draggingTabId, tabs, clearTabDragGlobals, removePointerTracker]);

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
