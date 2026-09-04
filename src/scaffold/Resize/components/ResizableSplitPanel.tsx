/**
 * ResizableSplitPanel resize-scaffold component
 *
 * A reusable component for creating horizontal split views with a resizable divider.
 * Uses pure DOM manipulation during drag for maximum performance (0 React renders).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

import { useResizeContextMenu } from "@src/hooks/ui/useResizeContextMenu";

import { VerticalResizeHandle } from "./ResizeHandle";

interface ResizableSplitPanelProps {
  /** Left panel content */
  leftPanel: React.ReactNode;
  /** Right panel content */
  rightPanel: React.ReactNode;
  /** Initial left panel width in pixels (default: half of container) */
  defaultLeftWidth?: number;
  /** Minimum left panel width in pixels */
  minLeftWidth?: number;
  /** Maximum left panel width in pixels */
  maxLeftWidth?: number;
  /** Default right panel width in pixels (used if defaultLeftWidth not provided) */
  defaultRightWidth?: number;
  /** Minimum right panel width in pixels */
  minRightWidth?: number;
  /** Maximum right panel width in pixels */
  maxRightWidth?: number;
  /** Additional className for the container */
  className?: string;
  /** Additional className for the left panel wrapper */
  leftPanelClassName?: string;
  /** Callback when split position changes */
  onSplitChange?: (leftWidth: number) => void;
  /** Reverse the visual order of panels (left appears on right, right on left) */
  reversed?: boolean;
  /** Width to reset to when user selects "Resize to default width" from context menu.
   *  If not provided, falls back to the initial defaultLeftWidth value. */
  resetWidth?: number;
  /** Callback when user selects "Close panel" from context menu */
  onClose?: () => void;
  /** When true, disables the right-click resize context menu on the handle */
  disableContextMenu?: boolean;
  /** Whether the resize boundary draws a resting separator line. */
  showDivider?: boolean;
}

const ResizableSplitPanel: React.FC<ResizableSplitPanelProps> = ({
  leftPanel,
  rightPanel,
  defaultLeftWidth,
  minLeftWidth = 200,
  maxLeftWidth = 800,
  defaultRightWidth,
  minRightWidth = 200,
  maxRightWidth,
  className = "",
  leftPanelClassName = "",
  onSplitChange,
  reversed = false,
  resetWidth,
  onClose,
  disableContextMenu = false,
  showDivider = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const prevDefaultLeftWidthRef = useRef<number | undefined>(defaultLeftWidth);
  const rafRef = useRef<number>(0);
  const pendingWidthRef = useRef<number>(0);
  const isResizingRef = useRef<boolean>(false);
  const hasDraggedRef = useRef<boolean>(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  // Capture the initial defaultLeftWidth for reset fallback (never changes)
  const [initialDefaultWidth] = useState<number | undefined>(defaultLeftWidth);

  // Initialize with default width immediately to prevent flash
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    if (defaultLeftWidth) return defaultLeftWidth;
    return minLeftWidth;
  });

  // Cleanup drag listeners on unmount
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  // Calculate effective constraints based on container size
  const getEffectiveConstraints = useCallback(() => {
    if (!containerRef.current) {
      return { min: minLeftWidth, max: maxLeftWidth };
    }
    const containerWidth = containerRef.current.getBoundingClientRect().width;
    const effectiveMax = Math.min(maxLeftWidth, containerWidth - minRightWidth);
    const effectiveMin = maxRightWidth
      ? Math.max(minLeftWidth, containerWidth - maxRightWidth)
      : minLeftWidth;
    return { min: effectiveMin, max: effectiveMax };
  }, [minLeftWidth, maxLeftWidth, minRightWidth, maxRightWidth]);

  /**
   * PURE DOM RESIZE - Zero React renders during drag!
   * - Ignores double-click to prevent accidental behavior
   * - Only commits width change when user actually drags
   * - Only sets cursor after actual mouse movement (prevents click-triggered changes)
   */
  const handleMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();

      // Ignore double-click (detail >= 2) to prevent accidental triggers
      if (event.detail >= 2) {
        return;
      }

      // Prevent duplicate resize sessions
      if (isResizingRef.current) return;
      isResizingRef.current = true;
      hasDraggedRef.current = false;

      const startX = event.clientX;
      const startWidth = leftWidth;
      pendingWidthRef.current = startWidth;

      // DON'T set cursor here - only set it after actual mouse movement

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // Only start visual feedback after first actual movement
        if (!hasDraggedRef.current) {
          hasDraggedRef.current = true;
          // Set cursor globally - only when actually dragging
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }

        const { min, max } = getEffectiveConstraints();
        const delta = reversed
          ? startX - moveEvent.clientX
          : moveEvent.clientX - startX;
        const newWidth = Math.max(min, Math.min(max, startWidth + delta));
        pendingWidthRef.current = newWidth;

        // Cancel previous RAF
        if (rafRef.current) cancelAnimationFrame(rafRef.current);

        // Schedule DOM update
        rafRef.current = requestAnimationFrame(() => {
          if (leftPanelRef.current) {
            leftPanelRef.current.style.width = `${newWidth}px`;
          }
        });
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);

        // Only do cleanup if we actually started dragging
        if (hasDraggedRef.current) {
          if (rafRef.current) cancelAnimationFrame(rafRef.current);

          document.body.style.cursor = "";
          document.body.style.userSelect = "";

          // Clear inline style, let React state take over
          if (leftPanelRef.current) {
            leftPanelRef.current.style.width = "";
          }

          // Commit width change
          setLeftWidth(pendingWidthRef.current);
          onSplitChange?.(pendingWidthRef.current);
        }
        isResizingRef.current = false;
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);

      dragCleanupRef.current = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        isResizingRef.current = false;
      };
    },
    [leftWidth, getEffectiveConstraints, reversed, onSplitChange]
  );

  // Sync defaultLeftWidth to leftWidth when the parent changes it
  useEffect(() => {
    if (defaultLeftWidth === undefined) {
      prevDefaultLeftWidthRef.current = defaultLeftWidth;
      return;
    }

    const prevWidth = prevDefaultLeftWidthRef.current ?? 0;
    if (prevWidth !== defaultLeftWidth) {
      const newWidth = defaultLeftWidth;
      queueMicrotask(() => setLeftWidth(newWidth));
    }

    prevDefaultLeftWidthRef.current = defaultLeftWidth;
  }, [defaultLeftWidth]);

  // Update left width when container size changes (for defaultRightWidth)
  useEffect(() => {
    if (defaultRightWidth && containerRef.current && !defaultLeftWidth) {
      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const newWidth = containerWidth - defaultRightWidth;
      queueMicrotask(() => setLeftWidth(newWidth));
    }
  }, [defaultRightWidth, defaultLeftWidth]);

  // Handle container resize (including sidebar toggle) to keep right panel at fixed width
  useEffect(() => {
    if (!defaultRightWidth || defaultLeftWidth) return;

    const handleResize = () => {
      if (containerRef.current) {
        const containerWidth =
          containerRef.current.getBoundingClientRect().width;
        const newLeftWidth = containerWidth - defaultRightWidth;
        const { min, max } = getEffectiveConstraints();
        const clampedWidth = Math.max(min, Math.min(max, newLeftWidth));
        setLeftWidth(clampedWidth);
        onSplitChange?.(clampedWidth);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [
    defaultRightWidth,
    defaultLeftWidth,
    getEffectiveConstraints,
    onSplitChange,
  ]);

  // Width change handler for context menu — updates internal state + notifies parent
  const handleContextMenuWidthChange = useCallback(
    (width: number) => {
      setLeftWidth(width);
      onSplitChange?.(width);
    },
    [onSplitChange]
  );

  // Right-click context menu on resize handle — native OS menu
  const resolvedResetWidth =
    resetWidth ?? (defaultLeftWidth || initialDefaultWidth || minLeftWidth);
  const contextMenuHandler = useResizeContextMenu({
    dimension: "width",
    currentSize: leftWidth,
    defaultSize: resolvedResetWidth,
    minSize: minLeftWidth,
    onSizeChange: handleContextMenuWidthChange,
    onClose,
  });
  const handleContextMenu = disableContextMenu ? undefined : contextMenuHandler;

  return (
    <div
      ref={containerRef}
      className={`relative flex h-full w-full overflow-hidden ${className}`}
      style={{
        contain: "layout style",
        flexDirection: reversed ? "row-reverse" : "row",
      }}
    >
      {/* Left Panel */}
      <div
        ref={leftPanelRef}
        className={`relative shrink-0 overflow-hidden ${leftPanelClassName}`.trim()}
        style={{
          width: `${leftWidth}px`,
          contain: "layout style",
          display: leftWidth === 0 ? "none" : "block",
        }}
        onContextMenu={handleContextMenu}
      >
        {leftPanel}
      </div>

      {/* Resize Handle - only show when left panel is visible */}
      {leftWidth > 0 && (
        <VerticalResizeHandle
          onMouseDown={handleMouseDown}
          onContextMenu={handleContextMenu}
          variant={showDivider ? "border" : "transparent"}
        />
      )}

      {/* Right Panel */}
      <div
        className="relative flex-1 overflow-hidden"
        style={{ contain: "inline-size layout style" }}
      >
        {rightPanel}
      </div>
    </div>
  );
};

// Memoize to prevent re-renders during page transitions
export default memo(ResizableSplitPanel);
