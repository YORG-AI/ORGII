/**
 * HoverSidebar Component
 *
 * Shows sidebar when user hovers over the left edge of the screen
 * when the sidebar is collapsed. Positioned as a floating overlay
 * that reuses the existing sidebar components.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";
import {
  DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
} from "@src/store/ui/sidebarAtom";

// ============================================
// Constants
// ============================================

const HOVER_TRIGGER_WIDTH = 12; // Width of the hover trigger zone in pixels
const HOVER_DELAY = 100; // Delay before showing sidebar (ms)
const HIDE_DELAY = 200; // Delay before hiding sidebar (ms)
const HOVER_SIDEBAR_WIDTH = DEFAULT_SIDEBAR_WIDTH; // Width of the hover sidebar

// ============================================
// HoverSidebarTrigger Component
// ============================================

/**
 * Invisible trigger zone on the left edge of the screen
 * Shows sidebar when user hovers over it
 */
const HoverSidebarTrigger: React.FC = () => {
  const location = useLocation();
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const setIsHoverSidebarOpen = useSetAtom(hoverSidebarOpenAtom);

  const showTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const isSelectRepoPage = location.pathname.includes("/orgii/app/select-repo");

  const handleMouseEnter = useCallback(() => {
    showTimeoutRef.current = setTimeout(() => {
      setIsHoverSidebarOpen(true);
    }, HOVER_DELAY);
  }, [setIsHoverSidebarOpen]);

  const handleMouseLeave = useCallback(() => {
    if (showTimeoutRef.current) {
      clearTimeout(showTimeoutRef.current);
      showTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (showTimeoutRef.current) {
        clearTimeout(showTimeoutRef.current);
      }
    };
  }, []);

  if (!isSidebarCollapsed || isSelectRepoPage) {
    return null;
  }

  return (
    <div
      className="fixed left-0 top-0 z-[9999] h-full"
      style={{ width: `${HOVER_TRIGGER_WIDTH}px` }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    />
  );
};

// ============================================
// HoverSidebarContainer Component
// ============================================

interface HoverSidebarContainerProps {
  children: React.ReactNode;
}

/**
 * Container that wraps the actual sidebar content when in hover mode
 * Acts as a positioned wrapper - the sidebar content handles its own styling
 */
const HoverSidebarContainer: React.FC<HoverSidebarContainerProps> = ({
  children,
}) => {
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const [isHoverSidebarOpen, setIsHoverSidebarOpen] =
    useAtom(hoverSidebarOpenAtom);

  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Drop inline browser webviews behind this floating sidebar while open.
  useOverlayLayer(isHoverSidebarOpen && isSidebarCollapsed);

  // Handle mouse enter on sidebar
  const handleMouseEnter = useCallback(() => {
    // Clear any pending hide timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, []);

  // Handle mouse leave from sidebar
  const handleMouseLeave = useCallback(() => {
    // Set timeout to hide sidebar
    hideTimeoutRef.current = setTimeout(() => {
      setIsHoverSidebarOpen(false);
    }, HIDE_DELAY);
  }, [setIsHoverSidebarOpen]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && isHoverSidebarOpen) {
        setIsHoverSidebarOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isHoverSidebarOpen, setIsHoverSidebarOpen]);

  // Don't render if sidebar is not collapsed or hover sidebar is not open
  if (!isSidebarCollapsed || !isHoverSidebarOpen) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="animate-in slide-in-from-left fixed left-0 top-0 z-[9998] h-full shadow-2xl duration-150"
      style={{
        width: `${HOVER_SIDEBAR_WIDTH}px`,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
    </div>
  );
};

// ============================================
// Default Export
// ============================================

const HoverSidebar = {
  Trigger: HoverSidebarTrigger,
  Container: HoverSidebarContainer,
};

export default HoverSidebar;
