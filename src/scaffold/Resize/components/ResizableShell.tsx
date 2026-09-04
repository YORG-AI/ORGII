/**
 * ResizableShell Component
 *
 * Universal wrapper component for any resizable element.
 * All panels, sidebars, and splits should use this component.
 *
 * Architecture:
 * ```
 * ┌─────────────────────────────┐
 * │ ResizableShell (container)  │
 * │  ├── GhostLayer (preview)   │  ← Only this changes during resize
 * │  ├── Content (children)     │  ← Static during resize
 * │  └── ResizeHandle (drag)    │
 * └─────────────────────────────┘
 * ```
 *
 * Usage:
 * ```tsx
 * <ResizableShell
 *   size={leftPanelWidth}
 *   axis="x"
 *   min={200}
 *   max={600}
 *   onResizeEnd={(size) => setLeftPanelWidth(size)}
 * >
 *   <LeftPanelContent />
 * </ResizableShell>
 * ```
 */
import React, { memo, useCallback, useMemo } from "react";

import { useResizeController } from "../hooks/useResizeController";
import type { ResizableShellProps } from "../types";
import { GhostLayer } from "./GhostLayer";
import { ResizeHandle } from "./ResizeHandle";

// ============================================
// Component
// ============================================

export const ResizableShell: React.FC<ResizableShellProps> = memo(
  ({
    children,
    size,
    axis,
    min = 100,
    max = 800,
    handlePosition = "end",
    inverted = false,
    onResizeEnd,
    className = "",
    showGhost = true,
  }) => {
    // Use resize controller
    const { containerRef, ghostRef, start, isResizing, previewSize } =
      useResizeController({
        axis,
        min,
        max,
        onCommit: onResizeEnd,
        handlePosition,
        inverted,
      });

    // Handle mouse down on resize handle
    const handleMouseDown = useCallback(
      (event: React.MouseEvent) => {
        start(event, size);
      },
      [start, size]
    );

    // Calculate container styles
    const containerStyles = useMemo<React.CSSProperties>(() => {
      const displaySize =
        isResizing && previewSize !== null ? previewSize : size;

      return {
        position: "relative",
        [axis === "x" ? "width" : "height"]: displaySize,
        // Disable transitions during resize for smooth performance
        transition: isResizing ? "none" : undefined,
        // Optimize for resize
        willChange: isResizing ? (axis === "x" ? "width" : "height") : "auto",
      };
    }, [axis, size, isResizing, previewSize]);

    return (
      <div
        ref={containerRef}
        className={`resizable-shell shrink-0 overflow-hidden ${className}`}
        style={containerStyles}
      >
        {/* Ghost Layer - Only visible during resize */}
        {showGhost && <GhostLayer ref={ghostRef} axis={axis} />}

        {/* Content - Static during resize */}
        <div className="resizable-content absolute inset-0 overflow-hidden">
          {children}
        </div>

        {/* Resize Handle */}
        <ResizeHandle
          axis={axis}
          onMouseDown={handleMouseDown}
          isResizing={isResizing}
        />
      </div>
    );
  }
);

ResizableShell.displayName = "ResizableShell";

// ============================================
// Convenience Components
// ============================================

/**
 * Left panel shell (horizontal resize, handle on right)
 */
export const LeftPanelShell: React.FC<
  Omit<ResizableShellProps, "axis" | "handlePosition">
> = memo((props) => (
  <ResizableShell {...props} axis="x" handlePosition="end" />
));

LeftPanelShell.displayName = "LeftPanelShell";

/**
 * Right panel shell (horizontal resize, handle on left, inverted)
 */
export const RightPanelShell: React.FC<
  Omit<ResizableShellProps, "axis" | "handlePosition" | "inverted">
> = memo((props) => (
  <ResizableShell {...props} axis="x" handlePosition="start" inverted />
));

RightPanelShell.displayName = "RightPanelShell";

/**
 * Bottom panel shell (vertical resize, handle on top, inverted)
 */
export const BottomPanelShell: React.FC<
  Omit<ResizableShellProps, "axis" | "handlePosition" | "inverted">
> = memo((props) => (
  <ResizableShell {...props} axis="y" handlePosition="start" inverted />
));

BottomPanelShell.displayName = "BottomPanelShell";

/**
 * Top panel shell (vertical resize, handle on bottom)
 */
export const TopPanelShell: React.FC<
  Omit<ResizableShellProps, "axis" | "handlePosition">
> = memo((props) => (
  <ResizableShell {...props} axis="y" handlePosition="end" />
));

TopPanelShell.displayName = "TopPanelShell";

export default ResizableShell;
