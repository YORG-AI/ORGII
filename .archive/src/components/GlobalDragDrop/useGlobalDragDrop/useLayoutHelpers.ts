/**
 * useLayoutHelpers Hook
 *
 * Computes positioning for the drag-over indicator. The indicator either
 * centers on the currently visible chat panel (if one is mounted) or on the
 * viewport.
 */
import React, { useCallback } from "react";

import type { IndicatorLocation } from "../types";

export interface UseLayoutHelpersReturn {
  getContainerStyle: (location: IndicatorLocation) => React.CSSProperties;
}

/** Selector must match ChatPanel's data-chat-panel attribute */
const CHAT_PANEL_SELECTOR = "[data-chat-panel]";

function getChatPanelCenterX(): number | null {
  const panel = document.querySelector(CHAT_PANEL_SELECTOR);
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  if (!rect.width) return null;
  return rect.left + rect.width / 2;
}

export function useLayoutHelpers(): UseLayoutHelpersReturn {
  const getContainerStyle = useCallback(
    (location: IndicatorLocation): React.CSSProperties => {
      if (location === "chat-panel") {
        const centerX = getChatPanelCenterX();
        if (centerX !== null) {
          return {
            position: "fixed",
            top: "50%",
            left: `${centerX}px`,
            transform: "translate(-50%, -50%)",
            zIndex: 9999,
            pointerEvents: "none",
          };
        }
      }
      return {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 9999,
        pointerEvents: "none",
      };
    },
    []
  );

  return { getContainerStyle };
}
