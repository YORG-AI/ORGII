/**
 * CustomScrollbar Component
 *
 * A fully custom scrollbar that hides native scrollbar and provides
 * IDE-style scrollbar with optional markers (e.g., for conflicts, search results)
 *
 * Performance notes:
 * - Thumb position is updated via direct DOM manipulation (not React state)
 *   and coalesced with requestAnimationFrame.
 * - The track is pointer-events:none so wheel events always reach the native
 *   scroller underneath, preserving macOS inertial momentum scrolling.
 * - Visibility uses the app-wide transient scrollbar controller, so mounted
 *   editors add no idle timers and share the same scroll-only reveal policy.
 */
import React, { useCallback, useEffect, useRef } from "react";

import {
  clearTransientScrollbar,
  revealTransientScrollbar,
} from "@src/util/ui/transientScrollbars";

import "./index.scss";

// ============================================
// Types
// ============================================

export interface ScrollbarMarker {
  id: string;
  /** Line number (0-based) */
  line: number;
  /** Number of lines this marker spans */
  lineCount?: number;
  /** Color of the marker */
  color?: string;
  /** Tooltip text */
  tooltip?: string;
  /** Click handler */
  onClick?: () => void;
}

interface CustomScrollbarProps {
  /** The scrollable element to sync with */
  scrollElement: HTMLElement | null;
  /** Total number of lines in the document */
  totalLines: number;
  /** Optional markers to display on the scrollbar */
  markers?: ScrollbarMarker[];
  /** Callback when clicking on the scrollbar to scroll to a line */
  onScrollToLine?: (lineNumber: number) => void;
  /** Custom class name */
  className?: string;
}

// ============================================
// Component
// ============================================

export const CustomScrollbar: React.FC<CustomScrollbarProps> = ({
  scrollElement,
  totalLines,
  markers = [],
  onScrollToLine,
  className = "",
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartY = useRef(0);
  const dragStartScrollTop = useRef(0);
  const thumbTopRef = useRef(0);
  const thumbHeightRef = useRef(30);
  const rafIdRef = useRef(0);
  const dragListenerCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    scrollerRef.current = scrollElement;
  }, [scrollElement]);

  // Direct DOM update — bypasses React render cycle entirely.
  // Reads layout first, then writes — avoids layout thrashing.
  const updateThumbDOM = useCallback(() => {
    const scroller = scrollElement;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!scroller || !track || !thumb) return;

    // --- Layout reads (batched) ---
    const { scrollTop, scrollHeight, clientHeight } = scroller;
    const trackHeight = track.clientHeight;

    if (scrollHeight <= 0 || clientHeight <= 0 || trackHeight <= 0) {
      thumbTopRef.current = 0;
      thumbHeightRef.current = 30;
      thumb.style.transform = "translate3d(0,0,0)";
      thumb.style.height = "30px";
      return;
    }

    const thumbHeight = Math.max(
      (clientHeight / scrollHeight) * trackHeight,
      30
    );
    const maxScrollTop = scrollHeight - clientHeight;
    const scrollRatio = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;
    const maxThumbTop = trackHeight - thumbHeight;
    const thumbTop = scrollRatio * maxThumbTop;

    const safeTop = Number.isFinite(thumbTop) ? thumbTop : 0;
    const safeHeight = Number.isFinite(thumbHeight) ? thumbHeight : 30;

    thumbTopRef.current = safeTop;
    thumbHeightRef.current = safeHeight;

    // --- DOM writes (after all reads) ---
    thumb.style.transform = `translate3d(0,${safeTop}px,0)`;
    thumb.style.height = `${safeHeight}px`;
  }, [scrollElement]);

  const handleThumbDrag = useCallback((clientY: number) => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (!scroller || !track || !isDraggingRef.current) return;

    const trackHeight = track.clientHeight;
    const thumbHeight = thumbHeightRef.current;

    const deltaY = clientY - dragStartY.current;
    const newThumbTop = Math.max(
      0,
      Math.min(trackHeight - thumbHeight, dragStartScrollTop.current + deltaY)
    );

    const maxThumbTop = trackHeight - thumbHeight;
    const scrollRatio = maxThumbTop > 0 ? newThumbTop / maxThumbTop : 0;
    const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = scrollRatio * maxScrollTop;
  }, []);

  const stopThumbDrag = useCallback(() => {
    dragListenerCleanupRef.current?.();
    dragListenerCleanupRef.current = null;
    isDraggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const handleThumbMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragListenerCleanupRef.current?.();
      isDraggingRef.current = true;
      if (trackRef.current) revealTransientScrollbar(trackRef.current);
      dragStartY.current = event.clientY;
      dragStartScrollTop.current = thumbTopRef.current;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const handleMouseMove = (moveEvent: MouseEvent) => {
        handleThumbDrag(moveEvent.clientY);
      };
      const handleMouseUp = () => stopThumbDrag();
      const cleanupDragListeners = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };
      dragListenerCleanupRef.current = cleanupDragListeners;
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [handleThumbDrag, stopThumbDrag]
  );

  useEffect(() => {
    const scroller = scrollElement;
    const track = trackRef.current;
    if (!scroller || !track) return;

    const handleScroll = () => {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        updateThumbDOM();
        // Reveal AFTER layout reads to avoid forced style recalculation.
        revealTransientScrollbar(track);
      });
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });

    const initialRafId = requestAnimationFrame(updateThumbDOM);

    return () => {
      cancelAnimationFrame(initialRafId);
      cancelAnimationFrame(rafIdRef.current);
      scroller.removeEventListener("scroll", handleScroll);
      clearTransientScrollbar(track);
      if (isDraggingRef.current) stopThumbDrag();
    };
  }, [scrollElement, updateThumbDOM, stopThumbDrag]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      updateThumbDOM();
    });
    if (scrollElement) observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [scrollElement, updateThumbDOM]);

  if (!scrollElement) return null;

  return (
    <div ref={trackRef} className={`custom-scrollbar-track ${className}`}>
      {/* Markers */}
      {markers.map((marker) => {
        const topPercent =
          totalLines > 0 ? (marker.line / totalLines) * 100 : 0;
        const lineCount = marker.lineCount || 1;
        const heightPercent =
          totalLines > 0 ? Math.max((lineCount / totalLines) * 100, 0.5) : 0.5;

        return (
          <div
            key={marker.id}
            className="custom-scrollbar-marker"
            style={{
              top: `${topPercent}%`,
              height: `${heightPercent}%`,
              backgroundColor: marker.color || "rgba(255, 165, 0, 0.9)",
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (marker.onClick) {
                marker.onClick();
              } else if (onScrollToLine) {
                onScrollToLine(marker.line);
              }
            }}
            title={marker.tooltip}
          />
        );
      })}

      {/* Scrollbar thumb — positioned via transform (GPU-accelerated) */}
      <div
        ref={thumbRef}
        className="custom-scrollbar-thumb"
        onMouseDown={handleThumbMouseDown}
      />
    </div>
  );
};

CustomScrollbar.displayName = "CustomScrollbar";

export default CustomScrollbar;
