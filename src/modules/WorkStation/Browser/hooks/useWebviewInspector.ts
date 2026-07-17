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

import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("useWebviewInspector");

// ============================================
// Types
// ============================================

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementComputedStyle {
  display: string | null;
  position: string | null;
  color: string | null;
  backgroundColor: string | null;
  fontSize: string | null;
  fontFamily: string | null;
}

/** Simple source location (path and line only) */
export interface SimpleSourceLocation {
  path: string;
  line: number;
}

/** Component stack entry (for React component hierarchy) */
export interface ComponentStackEntry {
  name: string;
  source: SimpleSourceLocation | null;
}

/**
 * Source location information for an element.
 *
 * Detection method:
 * - component-index: Uses Orgii's AST-based component index lookup (primary method)
 *   Supports: React (.tsx/.jsx), Vue (.vue), Svelte (.svelte)
 */
export interface SourceLocation {
  /** Detection method used */
  method: "component-index";
  /** File path (may be absolute or relative) */
  path: string | null;
  /** Line number (1-indexed) */
  line: number | null;
  /** Column number (0-indexed) */
  column: number | null;
  /** Component name (if detected) */
  componentName: string | null;
  /** Component stack (for React - shows component hierarchy) */
  componentStack: ComponentStackEntry[] | null;
  /** Search hint for finding the file (component name or pattern) */
  searchHint: string | null;
}

export interface ElementInfo {
  tagName: string;
  selector: string;
  id: string | null;
  className: string | null;
  attributes: Record<string, string>;
  innerText: string;
  innerHTML: string;
  rect: ElementRect;
  computedStyle: ElementComputedStyle;
  role: string;
  xpath: string;
  /** Source code location (if detected) */
  sourceLocation: SourceLocation | null;
}

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

  useVisiblePolling({
    enabled: isInspectMode && enabled && !!webviewLabel && pollInterval > 0,
    intervalMs: pollInterval,
    poll: refreshSelection,
  });

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
