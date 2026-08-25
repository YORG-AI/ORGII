/**
 * useTextSelectionDropdown Hook
 *
 * Detects DOM text selection within an optional container and owns the
 * dropdown's transient position/text/visibility lifecycle.
 *
 * Features:
 * - Listens for mouseup events to detect text selection
 * - Calculates dropdown position based on selection
 * - Closes on Escape; the dropdown component owns outside-click dismissal
 * - Cancels debounced and delayed cleanup work on unmount
 *
 * @example
 * const selection = useTextSelectionDropdown({ containerRef });
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { useDebouncedCallback } from "@src/hooks/perf";
import { getUiScaleFromCssVar } from "@src/lib/dndKit";

import {
  UseTextSelectionDropdownOptions,
  UseTextSelectionDropdownReturn,
} from "./types";

// ============================================
// Constants
// ============================================

const SELECTION_DEBOUNCE_MS = 100;
const SELECTION_CLEAR_DELAY_MS = 200;

// ============================================
// Hook Implementation
// ============================================

export function useTextSelectionDropdown(
  options: UseTextSelectionDropdownOptions
): UseTextSelectionDropdownReturn {
  const { containerRef } = options;

  // State
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [selectedText, setSelectedText] = useState("");
  const clearSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const cancelSelectionClear = useCallback(() => {
    if (clearSelectionTimerRef.current === null) return;
    clearTimeout(clearSelectionTimerRef.current);
    clearSelectionTimerRef.current = null;
  }, []);

  // Show dropdown at position
  const showDropdown = useCallback(
    (newPosition: { x: number; y: number }, text: string) => {
      if (!text.trim()) return;

      cancelSelectionClear();
      setSelectedText(text.trim());
      setPosition(newPosition);
      setVisible(true);
    },
    [cancelSelectionClear]
  );

  // Hide dropdown
  const hideDropdown = useCallback(() => {
    setVisible(false);
    // Keep text for animation exit
    cancelSelectionClear();
    clearSelectionTimerRef.current = setTimeout(() => {
      setSelectedText("");
      clearSelectionTimerRef.current = null;
    }, SELECTION_CLEAR_DELAY_MS);
  }, [cancelSelectionClear]);

  useEffect(() => {
    return () => cancelSelectionClear();
  }, [cancelSelectionClear]);

  const debouncedHandleMouseUp = useDebouncedCallback((event: MouseEvent) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const text = selection.toString().trim();
    if (!text) return;

    if (containerRef?.current) {
      const range = selection.getRangeAt(0);
      const commonAncestor = range.commonAncestorContainer;
      const container = containerRef.current;

      if (!container.contains(commonAncestor)) {
        return;
      }
    }

    const offsetX = 10;
    const offsetY = 10;
    const uiScale = getUiScaleFromCssVar();

    showDropdown(
      {
        x: event.clientX / uiScale + offsetX,
        y: event.clientY / uiScale + offsetY,
      },
      text
    );
  }, SELECTION_DEBOUNCE_MS);

  // Listen for mouseup events to detect selection
  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      debouncedHandleMouseUp(event);
    };

    const container = containerRef?.current ?? document;
    container.addEventListener("mouseup", handleMouseUp as EventListener);

    return () => {
      debouncedHandleMouseUp.cancel();
      container.removeEventListener("mouseup", handleMouseUp as EventListener);
    };
  }, [containerRef, debouncedHandleMouseUp]);

  // Keep the only document-level listener demand-driven while the menu is open.
  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hideDropdown();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hideDropdown, visible]);

  return {
    visible,
    position,
    selectedText,
    showDropdown,
    hideDropdown,
  };
}

export default useTextSelectionDropdown;
