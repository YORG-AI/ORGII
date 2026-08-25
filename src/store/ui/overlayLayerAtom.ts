/**
 * Overlay occlusion registry for native inline WebViews.
 *
 * Tauri child WebViews are native surfaces rather than DOM descendants, so a
 * CSS z-index cannot place a React portal above them. Each mounted overlay
 * publishes its current viewport rectangle here. Browser surfaces consume the
 * registry, intersect it with their own frame, and project only those holes to
 * the native compositor.
 */
import { atom, useSetAtom } from "jotai";
import {
  type RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

export interface OverlayOcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayLayerEntry {
  id: string;
  rect: OverlayOcclusionRect | null;
  /** Interactive overlays temporarily own pointer input over the browser. */
  blocksNativeInput: boolean;
}

export interface OverlayLayerOptions {
  /** Passive overlays such as tooltips can leave native page input enabled. */
  blocksNativeInput?: boolean;
}

export type OverlayLayerRegistry = Record<string, OverlayLayerEntry>;

export const overlayLayerRegistryAtom = atom<OverlayLayerRegistry>({});
overlayLayerRegistryAtom.debugLabel = "overlayLayerRegistryAtom";

export const activeOverlayCountAtom = atom(
  (get) => Object.keys(get(overlayLayerRegistryAtom)).length
);
activeOverlayCountAtom.debugLabel = "activeOverlayCountAtom";

export const overlayOcclusionStateAtom = atom((get) => {
  const entries = Object.values(get(overlayLayerRegistryAtom));
  return {
    rects: entries.flatMap((entry) => (entry.rect ? [entry.rect] : [])),
    blocksNativeInput: entries.some((entry) => entry.blocksNativeInput),
  };
});
overlayOcclusionStateAtom.debugLabel = "overlayOcclusionStateAtom";

function sameRect(
  left: OverlayOcclusionRect | null,
  right: OverlayOcclusionRect | null
): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
  );
}

function readElementRect(
  targetRef: RefObject<HTMLElement | null> | undefined
): OverlayOcclusionRect | null {
  const element = targetRef?.current;
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }

  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Register one portal/popup while it is visible.
 *
 * Geometry work exists only during the active lifetime. Scroll, resize, and
 * ResizeObserver bursts are coalesced to one measurement per animation frame,
 * and cleanup removes both listeners and the registry entry.
 */
export function useOverlayLayer(
  active: boolean,
  targetRef?: RefObject<HTMLElement | null>,
  options: OverlayLayerOptions = {}
): void {
  const id = useId();
  const setRegistry = useSetAtom(overlayLayerRegistryAtom);
  const frameRef = useRef<number | null>(null);
  const blocksNativeInput = options.blocksNativeInput ?? true;

  const publish = useCallback(() => {
    const nextRect = readElementRect(targetRef);
    setRegistry((previous) => {
      const current = previous[id];
      if (
        current &&
        current.blocksNativeInput === blocksNativeInput &&
        sameRect(current.rect, nextRect)
      ) {
        return previous;
      }

      return {
        ...previous,
        [id]: { id, rect: nextRect, blocksNativeInput },
      };
    });
  }, [blocksNativeInput, id, setRegistry, targetRef]);

  const schedulePublish = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      publish();
    });
  }, [publish]);

  useLayoutEffect(() => {
    if (!active) return;

    // Register synchronously for the non-macOS full-surface fallback. A
    // second measurement catches portaled elements mounted in this commit.
    publish();
    schedulePublish();

    const element = targetRef?.current;
    const resizeObserver =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedulePublish)
        : null;
    if (element) resizeObserver?.observe(element);

    window.addEventListener("resize", schedulePublish);
    window.addEventListener("scroll", schedulePublish, true);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePublish);
      window.removeEventListener("scroll", schedulePublish, true);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      setRegistry((previous) => {
        if (!previous[id]) return previous;
        const next = { ...previous };
        delete next[id];
        return next;
      });
    };
  }, [active, id, publish, schedulePublish, setRegistry, targetRef]);
}
