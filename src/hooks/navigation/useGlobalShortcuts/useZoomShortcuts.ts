import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { UI_SCALE_CONFIG, uiScaleAtom } from "@src/store/ui/uiAtom";

import { showScaleMessage } from "./types";

/**
 * Zoom shortcut handlers (Cmd+=, Cmd+-, Cmd+0)
 */
export function useZoomShortcuts() {
  const [uiScale, setUIScale] = useAtom(uiScaleAtom);

  // Use ref for uiScale to avoid recreating callbacks on every scale change
  const uiScaleRef = useRef(uiScale);
  useEffect(() => {
    uiScaleRef.current = uiScale;
  }, [uiScale]);

  // Handle Command+= or Command+Plus - Zoom in
  const handleZoomIn = useCallback(() => {
    const currentScale = uiScaleRef.current;
    const newScale = Math.min(
      currentScale + UI_SCALE_CONFIG.STEP,
      UI_SCALE_CONFIG.MAX
    );
    if (newScale !== currentScale) {
      setUIScale(newScale);
      showScaleMessage(newScale);
    }
  }, [setUIScale]);

  // Handle Command+- - Zoom out
  const handleZoomOut = useCallback(() => {
    const currentScale = uiScaleRef.current;
    const newScale = Math.max(
      currentScale - UI_SCALE_CONFIG.STEP,
      UI_SCALE_CONFIG.MIN
    );
    if (newScale !== currentScale) {
      setUIScale(newScale);
      showScaleMessage(newScale);
    }
  }, [setUIScale]);

  // Handle Command+0 - Reset zoom
  const handleZoomReset = useCallback(() => {
    const currentScale = uiScaleRef.current;
    if (currentScale !== UI_SCALE_CONFIG.DEFAULT) {
      setUIScale(UI_SCALE_CONFIG.DEFAULT);
      showScaleMessage(UI_SCALE_CONFIG.DEFAULT);
      return true;
    }
    return false;
  }, [setUIScale]);

  return {
    handleZoomIn,
    handleZoomOut,
    handleZoomReset,
  };
}
