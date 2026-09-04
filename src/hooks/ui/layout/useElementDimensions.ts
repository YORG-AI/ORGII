import { RefObject, useEffect, useLayoutEffect, useState } from "react";

/**
 * useElementDimensions Hook
 *
 * Consolidated hook for measuring element dimensions (width, height, or both).
 * Replaces useWidth, useHeight, and provides base for viewport-relative calculations.
 *
 * Features:
 * - ResizeObserver for accurate dimension tracking
 * - SSR-safe with useIsomorphicLayoutEffect
 * - Supports measuring width, height, or both
 * - Handles nested ref objects
 * - Window resize fallback
 */

// Use useLayoutEffect on client, useEffect on server (SSR safety)
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

export type DimensionType = "width" | "height" | "both";

export interface ElementDimensions {
  width: number;
  height: number;
}

export interface UseElementDimensionsOptions {
  /** What to measure: 'width', 'height', or 'both' */
  dimension?: DimensionType;
  /** Disable measurement and listener ownership while the element is absent. */
  enabled?: boolean;
  /** Additional dependency to trigger re-measurement */
  deps?: unknown[];
}

/**
 * Hook for measuring element dimensions with ResizeObserver
 *
 * @example
 * // Measure width only
 * const width = useElementDimensions(ref, { dimension: 'width' });
 *
 * @example
 * // Measure height only
 * const height = useElementDimensions(ref, { dimension: 'height' });
 *
 * @example
 * // Measure both dimensions
 * const { width, height } = useElementDimensions(ref, { dimension: 'both' });
 *
 * @example
 * // With additional dependencies
 * const width = useElementDimensions(ref, { dimension: 'width', deps: [isOpen] });
 */
export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions & { dimension: "width" }
): number;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions & { dimension: "height" }
): number;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options?: UseElementDimensionsOptions & { dimension?: "both" }
): ElementDimensions;

export function useElementDimensions(
  ref: RefObject<HTMLElement | null | { current?: HTMLElement | null }>,
  options: UseElementDimensionsOptions = {}
): number | ElementDimensions {
  const { dimension = "both", enabled = true, deps = [] } = options;

  const [dimensions, setDimensions] = useState<ElementDimensions>({
    width: 0,
    height: 0,
  });

  useIsomorphicLayoutEffect(() => {
    if (!enabled) return;

    const measureDimensions = () => {
      // Handle nested ref objects
      const element =
        ref.current instanceof HTMLElement
          ? ref.current
          : ref.current?.current instanceof HTMLElement
            ? ref.current.current
            : null;

      if (!element) return;

      const newDimensions: ElementDimensions = {
        width: element.clientWidth,
        height: element.clientHeight,
      };

      setDimensions((previousDimensions) => {
        if (
          previousDimensions.width === newDimensions.width &&
          previousDimensions.height === newDimensions.height
        ) {
          return previousDimensions;
        }
        return newDimensions;
      });
    };

    // Measure immediately
    measureDimensions();

    // Get the actual element
    const element =
      ref.current instanceof HTMLElement
        ? ref.current
        : ref.current?.current instanceof HTMLElement
          ? ref.current.current
          : null;

    // Set up ResizeObserver for accurate tracking
    let resizeObserver: ResizeObserver | null = null;
    if (element && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(measureDimensions);
      resizeObserver.observe(element);
    }

    // Listen for window resize as fallback
    window.addEventListener("resize", measureDimensions);

    return () => {
      window.removeEventListener("resize", measureDimensions);
      resizeObserver?.disconnect();
    };
  }, [ref, enabled, ...deps]);

  // Return based on requested dimension
  if (dimension === "width") return dimensions.width;
  if (dimension === "height") return dimensions.height;
  return dimensions;
}

export default useElementDimensions;
