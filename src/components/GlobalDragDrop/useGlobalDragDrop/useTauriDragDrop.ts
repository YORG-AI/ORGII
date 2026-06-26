/**
 * useTauriDragDrop Hook
 *
 * Subscribes to the Tauri WebviewWindow's native drag-drop events.
 *
 * Why this exists:
 *   With `dragDropEnabled: true` in tauri.conf.json (the default), the native
 *   layer swallows OS drag-drop before the WebView sees them — so the browser
 *   `drop` event never fires. The browser-level hook (`useBrowserDragDrop`)
 *   therefore only catches pure-JS drags that never leave the WebView.
 *
 *   For everything else — OS files from Finder / Explorer, and internal
 *   file-tree rows routed through `@crabnebula/tauri-plugin-drag` (which uses
 *   `startDrag` to perform a native drag) — we receive the drop through
 *   Tauri's IPC as a `TauriEvent::DragDrop` and convert it here into the same
 *   `handleIdeFileDrop` / `setDroppedFolder` calls the browser path uses.
 *
 * Contract:
 *   - `paths` always contains real filesystem paths (not Blob URLs).
 *   - `position` is in native pixels — hit-testing converts it back to DOM
 *     viewport pixels using `devicePixelRatio` and the main WebView zoom.
 */
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

import { createLogger } from "@src/hooks/logger";
import { clearInternalFileTreeDrag } from "@src/shared/dnd/dragSideChannel";

import type { DragDropBehavior, DroppedFolder } from "../types";
import {
  getChatDropTargetId,
  hasVisibleChatDropTarget,
  isDropInsideChatDropTarget,
  isRepositoryDropPage,
} from "./utils";

const log = createLogger("drag-drop");

export interface UseTauriDragDropOptions {
  handleIdeFileDrop: (
    filePath: string,
    fileName?: string,
    isFolder?: boolean,
    dropTargetId?: string
  ) => void;
  setDroppedFolder: (folder: DroppedFolder | null) => void;
  setIsDragging: (dragging: boolean) => void;
  setBehavior: (behavior: DragDropBehavior | null) => void;
}

/** Path helper — last segment of a POSIX-style path. */
function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

/**
 * Heuristic folder detection from a path string. Tauri's dragDrop event does
 * not tell us file vs directory directly; we infer from the last segment
 * having no extension. (Good enough for chat-pill display — the backend can
 * stat the path later if the exact type matters.)
 */
function looksLikeFolder(path: string): boolean {
  const name = basename(path);
  if (!name) return true;
  if (name.startsWith(".") && !name.includes(".", 1)) return true;
  return !/\.[A-Za-z0-9]{1,10}$/.test(name);
}

function resolveBehavior(position: {
  x: number;
  y: number;
}): DragDropBehavior | null {
  if (isDropInsideChatDropTarget(position)) {
    return { mode: "chat-file", location: "chat-panel" };
  }
  if (hasVisibleChatDropTarget()) {
    return { mode: "chat-file", location: "chat-panel" };
  }
  if (isRepositoryDropPage()) {
    return { mode: "repository", location: "center" };
  }
  return null;
}

export function useTauriDragDrop(options: UseTauriDragDropOptions): void {
  const { handleIdeFileDrop, setDroppedFolder, setIsDragging, setBehavior } =
    options;

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let cancelled = false;

    const webview = getCurrentWebviewWindow();

    webview
      .onDragDropEvent((event) => {
        const payload = event.payload;

        if (payload.type === "enter" || payload.type === "over") {
          const position = payload.position;
          const nextBehavior = resolveBehavior({
            x: position.x,
            y: position.y,
          });
          setBehavior(nextBehavior);
          setIsDragging(nextBehavior !== null);
          return;
        }

        if (payload.type === "leave") {
          setIsDragging(false);
          setBehavior(null);
          return;
        }

        if (payload.type === "drop") {
          setIsDragging(false);
          setBehavior(null);

          const paths = payload.paths;
          const position = payload.position;
          const dropPosition = {
            x: position.x,
            y: position.y,
          };
          const insideChatDropTarget = isDropInsideChatDropTarget(dropPosition);
          const dropTargetId = getChatDropTargetId(dropPosition);

          if (!paths || paths.length === 0) return;

          // Clear the global flags that signal an internal file-tree drag
          // initiated via `startDrag()`.  We're handling the drop here; the
          // browser-level listener must not also fire against the same paths.
          clearInternalFileTreeDrag();

          // Repository drop (Start page folder → "add as repo" modal).
          // Only fires outside the chat panel and when the payload is a
          // single folder.
          if (
            isRepositoryDropPage() &&
            !insideChatDropTarget &&
            paths.length === 1 &&
            looksLikeFolder(paths[0])
          ) {
            const path = paths[0];
            setDroppedFolder({ path, name: basename(path) });
            return;
          }

          if (insideChatDropTarget) {
            for (const path of paths) {
              handleIdeFileDrop(
                path,
                basename(path),
                looksLikeFolder(path),
                dropTargetId
              );
            }
          }
        }
      })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;
      })
      .catch((err) => {
        log.warn("[drag-drop] tauri:subscribe-failed", err);
      });

    return () => {
      cancelled = true;
      if (unlistenFn) unlistenFn();
    };
  }, [handleIdeFileDrop, setDroppedFolder, setIsDragging, setBehavior]);
}
