/**
 * useLspDropdown
 *
 * Owns the language-service dropdown open/close state for EditorStatusBar,
 * including the viewport-relative anchoring math for the portalled panel.
 */
import React, { useCallback, useRef, useState } from "react";

import { getViewportSize } from "@src/util/ui/window/viewport";

export interface LspDropdownPosition {
  bottom: number;
  right: number;
}

export interface UseLspDropdownReturn {
  lspDropdownOpen: boolean;
  lspButtonRef: React.RefObject<HTMLDivElement | null>;
  lspDropdownPosition: LspDropdownPosition | null;
  handleToggleLspDropdown: () => void;
  handleCloseLspDropdown: () => void;
}

/**
 * Compute the fixed-position offsets for the dropdown panel so that it sits
 * just above the anchor and is right-aligned with it.
 */
export function computeLspDropdownPosition(
  rect: Pick<DOMRect, "top" | "right">,
  viewport: { width: number; height: number }
): LspDropdownPosition {
  return {
    bottom: viewport.height - rect.top + 4,
    right: viewport.width - rect.right,
  };
}

export function useLspDropdown(): UseLspDropdownReturn {
  const [lspDropdownOpen, setLspDropdownOpen] = useState(false);
  const lspButtonRef = useRef<HTMLDivElement>(null);
  const [lspDropdownPosition, setLspDropdownPosition] =
    useState<LspDropdownPosition | null>(null);

  const handleToggleLspDropdown = useCallback(() => {
    if (lspDropdownOpen) {
      setLspDropdownOpen(false);
      setLspDropdownPosition(null);
    } else {
      setLspDropdownOpen(true);
      if (lspButtonRef.current) {
        const rect = lspButtonRef.current.getBoundingClientRect();
        const { width: vw, height: vh } = getViewportSize();
        setLspDropdownPosition(
          computeLspDropdownPosition(rect, { width: vw, height: vh })
        );
      }
    }
  }, [lspDropdownOpen]);

  const handleCloseLspDropdown = useCallback(() => {
    setLspDropdownOpen(false);
    setLspDropdownPosition(null);
  }, []);

  return {
    lspDropdownOpen,
    lspButtonRef,
    lspDropdownPosition,
    handleToggleLspDropdown,
    handleCloseLspDropdown,
  };
}
