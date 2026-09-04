/**
 * useSafeHover — Reliable hover state that won't get stuck.
 *
 * React's onMouseLeave can silently fail to fire when:
 * - The element is unmounted while hovered (conditional rendering, portals)
 * - The mouse exits the window too quickly
 * - A portal/overlay steals pointer events
 *
 * This hook adds two safety nets:
 * 1. Ref-callback detach always resets to `false` when node is removed.
 * 2. Uses native DOM listeners on a ref so we don't depend on React's
 *    synthetic event bubbling, which can be interrupted by portals.
 *
 * Returns `[ref, isHovered]` — attach `ref` to the element.
 */
import { type RefCallback, useCallback, useRef, useState } from "react";

export interface UseSafeHoverOptions {
  /** Disable hover tracking entirely (e.g. when component is disabled) */
  disabled?: boolean;
}

export function useSafeHover<T extends HTMLElement = HTMLElement>(
  options?: UseSafeHoverOptions
): [RefCallback<T>, boolean] {
  const elRef = useRef<T | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const disabled = options?.disabled ?? false;

  const enterRef = useRef(() => setIsHovered(true));
  const leaveRef = useRef(() => setIsHovered(false));

  const refCallback: RefCallback<T> = useCallback(
    (node: T | null) => {
      const prev = elRef.current;
      if (prev) {
        prev.removeEventListener("mouseenter", enterRef.current);
        prev.removeEventListener("mouseleave", leaveRef.current);
      }
      elRef.current = node;
      if (node && !disabled) {
        node.addEventListener("mouseenter", enterRef.current);
        node.addEventListener("mouseleave", leaveRef.current);
      } else {
        setIsHovered(false);
      }
    },
    [disabled]
  );

  return [refCallback, isHovered];
}
