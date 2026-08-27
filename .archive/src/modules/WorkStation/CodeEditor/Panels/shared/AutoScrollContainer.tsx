/**
 * AutoScrollContainer Component
 *
 * A scrollable container that automatically scrolls to bottom
 * when content changes. Used for Output, Debug console, Test results.
 *
 * Wraps useScrollToBottom hook with a standard container structure.
 */
import React, { memo, useRef } from "react";

import { useScrollToBottom } from "@src/hooks/ui/effects";

// ============================================
// Types
// ============================================

export interface AutoScrollContainerProps {
  /** Content to render inside the scrollable area */
  children: React.ReactNode;
  /** Dependencies that trigger auto-scroll when changed */
  scrollDependencies: React.DependencyList;
  /** Always scroll to bottom on change (default: true) */
  forceScroll?: boolean;
  /** Additional class name for the container */
  className?: string;
}

// ============================================
// Component
// ============================================

export const AutoScrollContainer: React.FC<AutoScrollContainerProps> = memo(
  ({ children, scrollDependencies, forceScroll = true, className = "" }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when dependencies change (VS Code-style)
    useScrollToBottom({
      containerRef,
      dependencies: scrollDependencies,
      forceScroll,
    });

    return (
      <div
        ref={containerRef}
        className={`min-h-0 flex-1 overflow-auto ${className}`}
      >
        {children}
      </div>
    );
  }
);

AutoScrollContainer.displayName = "AutoScrollContainer";

export default AutoScrollContainer;
