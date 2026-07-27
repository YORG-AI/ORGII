/**
 * useGlobalDragDrop Hook
 *
 * Main orchestrating hook for GlobalDragDrop component.
 * Composes sub-hooks for different drag-drop scenarios.
 */
import { useAtomValue } from "jotai";
import React, { useState } from "react";

import { workflowDragActiveAtom } from "@src/store/ui/workflowEditorAtom";

import type { UseGlobalDragDropReturn } from "./types";
import { useBrowserDragDrop } from "./useBrowserDragDrop";
import { useFileHandlers } from "./useFileHandlers";
import { useTauriDragDrop } from "./useTauriDragDrop";

export function useGlobalDragDrop(): UseGlobalDragDropReturn {
  // Core state
  const [isDragging, setIsDragging] = useState(false);
  // Track internal workflow drags.
  const workflowDragActive = useAtomValue(workflowDragActiveAtom);

  // Shared refs
  const dragDepthRef = React.useRef(0);
  const workflowDragActiveRef = React.useRef(false);
  const internalFileTreeDragRef = React.useRef(false);

  React.useEffect(() => {
    workflowDragActiveRef.current = workflowDragActive;
  }, [workflowDragActive]);

  // Sub-hooks
  const { handleIdeFileDrop, handleBrowserFileDrop } = useFileHandlers();

  useBrowserDragDrop({
    handleIdeFileDrop,
    handleBrowserFileDrop,
    setIsDragging,
    dragDepthRef,
    workflowDragActiveRef,
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
