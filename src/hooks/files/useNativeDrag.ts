/**
 * useNativeDrag Hook
 *
 * Enables native OS drag-out for file tree nodes using tauri-plugin-drag.
 * When the user drags a file/folder from the explorer beyond a small movement
 * threshold, this hook calls `startDrag()` to initiate a real OS-level drag
 * operation — allowing the user to drop files into Finder, Desktop, Slack,
 * or any external application that accepts file drops.
 *
 * Also sets the global `__internalFileTreeDrag` flag so that
 * `useTauriDragDrop` can recognise internal drag-back-into-webview drops.
 */
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { resolveResource } from "@tauri-apps/api/path";
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useRef,
} from "react";

import { createLogger } from "@src/hooks/logger";
import {
  clearInternalFileTreeDrag,
  setInternalFileTreeDrag,
} from "@src/shared/dnd/dragSideChannel";

const log = createLogger("NativeDrag");

const DRAG_THRESHOLD_PX = 5;

let cachedFileIcon: string | undefined;
let cachedFolderIcon: string | undefined;

async function getDragIcon(isDirectory: boolean): Promise<string> {
  if (isDirectory) {
    if (!cachedFolderIcon) {
      cachedFolderIcon = await resolveResource(
        "resources/drag-icons/folder-drag.png"
      );
    }
    return cachedFolderIcon;
  }
  if (!cachedFileIcon) {
    cachedFileIcon = await resolveResource(
      "resources/drag-icons/file-drag.png"
    );
  }
  return cachedFileIcon;
}

export interface NativeDragItem {
  path: string;
  name: string;
  type: "file" | "directory";
}

interface NativeDragState {
  active: boolean;
  startX: number;
  startY: number;
  item: NativeDragItem | null;
}

/**
 * Returns `onMouseDown` handler to attach to a draggable tree row.
 * The handler tracks mouse movement and initiates a native OS drag
 * once the movement exceeds a small threshold.
 */
export function useNativeDrag(rowRef: RefObject<HTMLDivElement | null>) {
  const stateRef = useRef<NativeDragState>({
    active: false,
    startX: 0,
    startY: 0,
    item: null,
  });

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, item: NativeDragItem) => {
      if (event.button !== 0) return;

      stateRef.current = {
        active: true,
        startX: event.clientX,
        startY: event.clientY,
        item,
      };

      const handleMouseMove = async (moveEvent: globalThis.MouseEvent) => {
        const state = stateRef.current;
        if (!state.active || !state.item) return;

        const deltaX = moveEvent.clientX - state.startX;
        const deltaY = moveEvent.clientY - state.startY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance < DRAG_THRESHOLD_PX) return;

        // Threshold exceeded — start native drag
        state.active = false;
        cleanup();

        const dragItem = state.item;

        setInternalFileTreeDrag({
          path: dragItem.path,
          name: dragItem.name,
          type: dragItem.type,
        });

        rowRef.current?.classList.add("is-dragging");

        try {
          const icon = await getDragIcon(dragItem.type === "directory");

          await startDrag(
            {
              item: [dragItem.path],
              icon,
            },
            (_payload) => {
              // Drag completed (dropped or cancelled) — clean up
              rowRef.current?.classList.remove("is-dragging");
              setTimeout(() => {
                clearInternalFileTreeDrag();
              }, 0);
            }
          );
        } catch (error) {
          log.error("[NativeDrag] startDrag failed:", error);
          rowRef.current?.classList.remove("is-dragging");
          clearInternalFileTreeDrag();
        }
      };

      const handleMouseUp = () => {
        stateRef.current.active = false;
        cleanup();
      };

      const cleanup = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [rowRef]
  );

  return { handleMouseDown };
}
