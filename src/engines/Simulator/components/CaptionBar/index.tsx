import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import Markdown from "@src/components/MarkDown";
import { getViewportSize } from "@src/util/ui/window/viewport";

interface CaptionBarProps {
  text: string;
  getPortalBounds?: () => { left: number; right: number } | null;
}

const CaptionBar: React.FC<CaptionBarProps> = memo(
  ({ text, getPortalBounds }) => {
    const [pinnedOpen, setPinnedOpen] = useState(false);
    const [panelPosition, setPanelPosition] = useState({
      top: 0,
      left: 0,
      width: 0,
      maxHeight: 240,
    });
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);

    const updatePanelPosition = useCallback(() => {
      const node = rootRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const { width: vw, height: vh } = getViewportSize();
      const bounds = getPortalBounds?.() ?? {
        left: 12,
        right: vw - 12,
      };
      const availableWidth = Math.max(160, bounds.right - bounds.left);
      const width = Math.min(600, availableWidth);
      const desiredCenter = rect.left + rect.width / 2;
      const halfWidth = width / 2;
      const left = Math.max(
        bounds.left + halfWidth,
        Math.min(desiredCenter, bounds.right - halfWidth)
      );
      const top = rect.bottom + 6;
      const maxHeight = Math.max(96, Math.min(240, vh - top - 12));
      setPanelPosition({ top, left, width, maxHeight });
    }, [getPortalBounds]);

    useEffect(() => {
      if (!pinnedOpen) return;
      updatePanelPosition();
      window.addEventListener("resize", updatePanelPosition);
      window.addEventListener("scroll", updatePanelPosition, true);
      return () => {
        window.removeEventListener("resize", updatePanelPosition);
        window.removeEventListener("scroll", updatePanelPosition, true);
      };
    }, [pinnedOpen, updatePanelPosition]);

    useEffect(() => {
      if (!pinnedOpen) return;
      const handleClick = (event: MouseEvent) => {
        const rootNode = rootRef.current;
        const panelNode = panelRef.current;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (rootNode?.contains(target) || panelNode?.contains(target)) return;
        setPinnedOpen(false);
      };
      document.addEventListener("click", handleClick);
      return () => document.removeEventListener("click", handleClick);
    }, [pinnedOpen]);

    const handleToggle = useCallback((event: React.MouseEvent) => {
      event.stopPropagation();
      setPinnedOpen((prev) => !prev);
    }, []);

    const expandedPanel = pinnedOpen
      ? createPortal(
          <div
            ref={panelRef}
            className="fixed z-[9999] flex -translate-x-1/2 items-center rounded-lg border border-solid border-border-2 bg-chat-input p-3 text-text-1 shadow-md"
            style={{
              top: panelPosition.top,
              left: panelPosition.left,
              width: panelPosition.width,
              minHeight: 28,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div
              className="chat-text overflow-y-auto text-[13px] leading-relaxed text-text-1 scrollbar-hide"
              style={{ maxHeight: panelPosition.maxHeight }}
            >
              <Markdown
                textContent={text}
                useChatCodeBlock={true}
                enableFileNavigation={true}
                skipPreprocess={false}
              />
            </div>
          </div>,
          document.body
        )
      : null;

    return (
      <div
        ref={rootRef}
        className="pointer-events-auto relative w-full min-w-0"
        data-testid="simulator-caption-bar"
      >
        {expandedPanel}
        <button
          type="button"
          onClick={handleToggle}
          className="flex h-7 w-full max-w-full cursor-pointer items-center px-3 text-[13px] text-text-2 transition-colors hover:text-text-1"
        >
          <span className="truncate">{text}</span>
        </button>
      </div>
    );
  }
);

CaptionBar.displayName = "CaptionBar";

export default CaptionBar;
