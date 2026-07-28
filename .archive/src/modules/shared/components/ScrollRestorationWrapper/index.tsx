/**
 * ScrollRestorationWrapper
 *
 * Wraps each KeepAlive-cached route to preserve scroll positions.
 * The keepalive library detaches/reattaches DOM elements when switching routes,
 * which resets scroll positions. This wrapper:
 * 1. Listens for scroll events (capture phase) to track all scrollable elements
 * 2. On deactivation: positions are already saved from scroll events
 * 3. On re-activation: restores saved scroll positions via requestAnimationFrame
 *
 * Uses useKeepAliveContext().active to detect activation state changes.
 */
import { useKeepAliveContext } from "keepalive-for-react";
import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react";

const ScrollRestorationWrapper: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Map from Element -> scrollTop. Updated on every scroll event.
  const scrollPositions = useRef(new WeakMap<Element, number>());
  // Track which elements have been scrolled (WeakMap doesn't support iteration)
  const scrolledElements = useRef(new Set<Element>());
  const { active } = useKeepAliveContext();
  const prevActiveRef = useRef(active);

  // Track scroll positions via capture-phase listener
  const handleScroll = useCallback((event: Event) => {
    const target = event.target as Element;
    if (target && target.scrollTop !== undefined && target.scrollTop > 0) {
      scrollPositions.current.set(target, target.scrollTop);
      scrolledElements.current.add(target);
    } else if (target) {
      // scrollTop is 0 - remove from tracked set
      scrollPositions.current.delete(target);
      scrolledElements.current.delete(target);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Capture phase to catch all scroll events including from nested elements
    container.addEventListener("scroll", handleScroll, true);
    return () => container.removeEventListener("scroll", handleScroll, true);
  }, [handleScroll]);

  // Restore scroll positions when re-activated
  useLayoutEffect(() => {
    if (active && !prevActiveRef.current && scrolledElements.current.size > 0) {
      // Component just became active again - restore scroll positions
      const elements = Array.from(scrolledElements.current);
      requestAnimationFrame(() => {
        for (const element of elements) {
          const savedTop = scrollPositions.current.get(element);
          if (savedTop !== undefined && element.isConnected) {
            element.scrollTop = savedTop;
          }
        }
      });
    }
    prevActiveRef.current = active;
  }, [active]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden">
      {children}
    </div>
  );
};

export default ScrollRestorationWrapper;
