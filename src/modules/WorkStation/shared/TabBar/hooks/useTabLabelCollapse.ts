import { type RefObject, useLayoutEffect, useRef, useState } from "react";

export interface UseTabLabelCollapseOptions {
  /** When false the hook is a no-op and never collapses labels. */
  enabled: boolean;
  /** Re-evaluate overflow when tabs or active tab changes. */
  tabsDependency: unknown;
  activeTabDependency: unknown;
  containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Collapses inactive tab labels when the tab strip overflows horizontally.
 * Uses a ResizeObserver to detect width changes and a rAF-deferred
 * scrollWidth check to determine whether tabs are overflowing.
 *
 * Returns `hideInactiveLabels: true` when labels should be hidden.
 */
export function useTabLabelCollapse({
  enabled,
  tabsDependency,
  activeTabDependency,
  containerRef,
}: UseTabLabelCollapseOptions): boolean {
  const [overflowCollapsed, setOverflowCollapsed] = useState(false);
  const tabStripWidthRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;

    let rafId: ReturnType<typeof requestAnimationFrame> | null = null;

    const updateCompact = () => {
      const node = containerRef.current;
      if (!node) return;
      const width = node.clientWidth;
      const prevWidth = tabStripWidthRef.current;
      tabStripWidthRef.current = width;

      if (prevWidth !== null && width > prevWidth + 10) {
        setOverflowCollapsed(false);
      }

      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const strip = containerRef.current;
        if (!strip) return;
        if (strip.scrollWidth > strip.clientWidth + 1) {
          setOverflowCollapsed(true);
        }
      });
    };

    const observer = new ResizeObserver(() => {
      updateCompact();
    });
    observer.observe(el);
    updateCompact();

    return () => {
      observer.disconnect();
      tabStripWidthRef.current = null;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [enabled, tabsDependency, activeTabDependency, containerRef]);

  return enabled && overflowCollapsed;
}
