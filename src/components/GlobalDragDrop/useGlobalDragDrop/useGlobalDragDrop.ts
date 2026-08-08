/**
 * useGlobalDragDrop Hook
 *
 * Main orchestrating hook for GlobalDragDrop component.
 * Composes sub-hooks for different drag-drop scenarios.
 */
import React, { useState } from "react";

import type { UseGlobalDragDropReturn } from "./types";
import { useBrowserDragDrop } from "./useBrowserDragDrop";
import { useFileHandlers } from "./useFileHandlers";
import { useTauriDragDrop } from "./useTauriDragDrop";

export function useGlobalDragDrop(): UseGlobalDragDropReturn {
  // Core state
  const [isDragging, setIsDragging] = useState(false);

  // Shared refs
  const dragDepthRef = React.useRef(0);
  const internalFileTreeDragRef = React.useRef(false);

  // Sub-hooks
  const { handleIdeFileDrop, handleBrowserFileDrop } = useFileHandlers();

  useBrowserDragDrop({
    handleIdeFileDrop,
    handleBrowserFileDrop,
    setIsDragging,
    dragDepthRef,
    internalFileTreeDragRef,
  });

  // Tauri-native drag-drop (OS Finder → WebView, plus internal startDrag
  // reentrants). With `dragDropEnabled: true` in tauri.conf.json — the
  // default — the browser `drop` event never fires for OS drags; we must
  // subscribe to the Tauri WebviewWindow event to get real filesystem paths.
  useTauriDragDrop({
    handleIdeFileDrop,
    setIsDragging,
  });

  return {
    isDragging,
  };
}
