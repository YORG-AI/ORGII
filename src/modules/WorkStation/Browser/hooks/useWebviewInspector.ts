/**
 * useWebviewInspector - Hook for element inspection in webviews
 *
 * Provides functionality to:
 * - Toggle inspect mode (hover to highlight, click to select)
 * - Get information about the selected element
 * - Clear selection
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DomSelectionComponentStackEntry,
  DomSelectionComputedStyle,
  DomSelectionElementInfo,
  DomSelectionRect,
  DomSelectionSourceLocation,
  DomSelectionSourcePoint,
} from "@src/features/DomSelection/types";
import { createLogger } from "@src/hooks/logger";
import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";

const log = createLogger("useWebviewInspector");

// ============================================
// Types
// ============================================

export type ElementRect = DomSelectionRect;
export type ElementComputedStyle = DomSelectionComputedStyle;
export type SimpleSourceLocation = DomSelectionSourcePoint;
export type ComponentStackEntry = DomSelectionComponentStackEntry;
/** Framework/debug source metadata detected without a repository index. */
export type SourceLocation = DomSelectionSourceLocation;
export type ElementInfo = DomSelectionElementInfo;

export interface UseWebviewInspectorOptions {
  /** Webview label to inspect */
  webviewLabel: string;
  /** Poll interval for checking selected element (ms) */
  pollInterval?: number;
  /** Callback when element is selected */
  onElementSelected?: (element: ElementInfo) => void;
  /** Whether inspector is enabled (for conditional polling) */
  enabled?: boolean;
}

export interface UseWebviewInspectorReturn {
  /** Whether inspect mode is currently enabled */
  isInspectMode: boolean;
  /** Toggle inspect mode on/off */
  toggleInspectMode: () => Promise<void>;
  /** Enable inspect mode */
  enableInspectMode: () => Promise<void>;
  /** Disable inspect mode */
  disableInspectMode: () => Promise<void>;
  /** Currently selected element info */
  selectedElement: ElementInfo | null;
  /** Clear the current selection */
  clearSelection: () => Promise<void>;
  /** Refresh the selected element info */
  refreshSelection: () => Promise<void>;
  /** Loading state */
  isLoading: boolean;
}

// ============================================
// Hook
// ============================================

export function useWebviewInspector(
  options: UseWebviewInspectorOptions
): UseWebviewInspectorReturn {
  const {
    webviewLabel,
    pollInterval = 500,
    onElementSelected,
    enabled = true,
  } = options;

  const [isInspectMode, setIsInspectMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(false);

  // Track previous selection to detect changes
  const prevSelectionRef = useRef<string | null>(null);
  const onElementSelectedRef = useRef(onElementSelected);

  // Keep callback ref up to date
  useEffect(() => {
    onElementSelectedRef.current = onElementSelected;
  }, [onElementSelected]);

  // Toggle inspect mode
  const toggleInspectMode = useCallback(async () => {
    if (!webviewLabel) return;

    setIsLoading(true);
    try {
      const newState = await invoke<boolean>("toggle_webview_inspect_mode", {
        label: webviewLabel,
      });
      setIsInspectMode(newState);

      if (!newState) {
        await invoke("clear_element_selection", { label: webviewLabel });
        setSelectedElement(null);
        prevSelectionRef.current = null;
      }
    } catch (error) {
      log.error("[useWebviewInspector] Toggle failed:", error);
    } finally {
      setIsLoading(false);
    }
  }, [webviewLabel]);

  // Enable inspect mode
  const enableInspectMode = useCallback(async () => {
    if (!webviewLabel) return;

    try {
      await invoke("enable_webview_inspect_mode", { label: webviewLabel });
      setIsInspectMode(true);
    } catch (error) {
      log.error("[useWebviewInspector] Enable failed:", error);
    }
  }, [webviewLabel]);

  // Disable inspect mode
  const disableInspectMode = useCallback(async () => {
    setIsInspectMode(false);
    setSelectedElement(null);
    prevSelectionRef.current = null;

    if (!webviewLabel) return;

    try {
      await invoke("disable_webview_inspect_mode", { label: webviewLabel });
      await invoke("clear_element_selection", { label: webviewLabel });
    } catch (error) {
      log.error("[useWebviewInspector] Disable failed:", error);
    }
  }, [webviewLabel]);

  // Get selected element info
  const refreshSelection = useCallback(async () => {
    if (!webviewLabel) return;

    try {
      const element = await invoke<ElementInfo | null>(
        "get_selected_element_info",
        { label: webviewLabel }
      );

      if (element) {
        // Check if selection changed
        const selectionKey = element.xpath || element.selector;
        if (selectionKey !== prevSelectionRef.current) {
          prevSelectionRef.current = selectionKey;
          setSelectedElement(element);
          onElementSelectedRef.current?.(element);
        }
      }
    } catch (error) {
      log.warn(
        "[useWebviewInspector] Polling error:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }, [webviewLabel]);

  // Clear selection
  const clearSelection = useCallback(async () => {
    if (!webviewLabel) return;

    try {
      await invoke("clear_element_selection", { label: webviewLabel });
      setSelectedElement(null);
      prevSelectionRef.current = null;
    } catch (error) {
      log.error("[useWebviewInspector] Clear selection failed:", error);
    }
  }, [webviewLabel]);

  // Poll for selected element changes when inspect mode is active
  useEffect(() => {
    if (!isInspectMode || !webviewLabel || !enabled || pollInterval <= 0) {
      return;
    }

    return startVisibilityAwarePoller(document, refreshSelection, pollInterval);
  }, [isInspectMode, webviewLabel, enabled, pollInterval, refreshSelection]);

  // Cleanup on unmount or webview change
  useEffect(() => {
    return () => {
      if (isInspectMode && webviewLabel) {
        // Best effort cleanup - don't await
        invoke("disable_webview_inspect_mode", { label: webviewLabel }).catch(
          () => {}
        );
      }
    };
  }, [webviewLabel, isInspectMode]);

  return {
    isInspectMode,
    toggleInspectMode,
    enableInspectMode,
    disableInspectMode,
    selectedElement,
    clearSelection,
    refreshSelection,
    isLoading,
  };
}

export default useWebviewInspector;
