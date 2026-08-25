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
  /** Black scrim alpha rendered above the live native surface. */
  nativeDimmingAlpha?: number;
  /**
   * When false, the rect only punches through the native dim layer (spotlight
   * tours) instead of cutting the live WebView backing surface.
   */
  cutsNativeSurface?: boolean;
  /** Contribute the rect to dim-layer holes without cutting the WebView. */
  dimHoleOnly?: boolean;
  /** Cut the live WebView surface without punching a matching dim-layer hole. */
  maskHoleOnly?: boolean;
}

export interface OverlayLayerOptions {
  /** Passive overlays such as tooltips can leave native page input enabled. */
  blocksNativeInput?: boolean;
  /**
   * Dim the live native page without removing it. Full-screen modals use this
   * while their opaque panel remains the registered occlusion rectangle.
   */
  nativeDimmingAlpha?: number;
  /**
   * When false, keep the live WebView painted and only mirror the scrim on a
   * native dim layer. Spotlight tours use this for glass popovers.
   */
  cutsNativeSurface?: boolean;
  /** Register a dim-layer hole without cutting the live WebView surface. */
  dimHoleOnly?: boolean;
  /** Cut the live WebView for opaque/glass UI without undimming the page. */
  maskHoleOnly?: boolean;
  /**
   * Extra CSS pixels around the measured rect so native compositor holes stay
   * aligned with React UI at panel boundaries and under shadows/borders.
   */
  occlusionSlop?: number;
}

const DEFAULT_OCCLUSION_SLOP = 4;
const MODAL_OCCLUSION_SLOP = 48;
/** Opaque dropdown panels should not inflate native holes beyond their bounds. */
export const DROPDOWN_OCCLUSION_OPTIONS: OverlayLayerOptions = {
  occlusionSlop: 0,
};

/** Modal dialog panel: mask hole aligned to opaque content, not a padded wrapper. */
export const MODAL_MASK_OCCLUSION_OPTIONS: OverlayLayerOptions = {
  maskHoleOnly: true,
  occlusionSlop: MODAL_OCCLUSION_SLOP,
};

function expandOverlayRect(
  rect: OverlayOcclusionRect,
  slop: number
): OverlayOcclusionRect {
  if (slop <= 0) return rect;
  return {
    x: rect.x - slop,
    y: rect.y - slop,
    width: rect.width + slop * 2,
    height: rect.height + slop * 2,
  };
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
  const maskRects: OverlayOcclusionRect[] = [];
  const dimHoleRects: OverlayOcclusionRect[] = [];

  for (const entry of entries) {
    if (!entry.rect) continue;
    const dimHoleOnly = entry.dimHoleOnly === true;
    const maskHoleOnly = entry.maskHoleOnly === true;
    const cutsNativeSurface = entry.cutsNativeSurface !== false;

    if (cutsNativeSurface && !dimHoleOnly) {
      maskRects.push(entry.rect);
    }
    if (!maskHoleOnly && (dimHoleOnly || cutsNativeSurface)) {
      dimHoleRects.push(entry.rect);
    }
  }

  return {
    maskRects,
    dimHoleRects,
    /** @deprecated Use maskRects — kept for callers not yet split. */
    rects: maskRects,
    blocksNativeInput: entries.some((entry) => entry.blocksNativeInput),
    nativeDimmingAlpha: entries.reduce(
      (strongest, entry) =>
        Math.max(strongest, normalizeDimmingAlpha(entry.nativeDimmingAlpha)),
      0
    ),
  };
});
overlayOcclusionStateAtom.debugLabel = "overlayOcclusionStateAtom";

function normalizeDimmingAlpha(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

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
  const nativeDimmingAlpha = normalizeDimmingAlpha(options.nativeDimmingAlpha);
  const cutsNativeSurface = options.cutsNativeSurface ?? true;
  const dimHoleOnly = options.dimHoleOnly ?? false;
  const maskHoleOnly = options.maskHoleOnly ?? false;
  const occlusionSlop =
    options.occlusionSlop ??
    (nativeDimmingAlpha > 0 && cutsNativeSurface
      ? MODAL_OCCLUSION_SLOP
      : DEFAULT_OCCLUSION_SLOP);

  const publish = useCallback(() => {
    const measuredRect = readElementRect(targetRef);
    const nextRect = measuredRect
      ? expandOverlayRect(measuredRect, occlusionSlop)
      : null;
    setRegistry((previous) => {
      const current = previous[id];
      if (
        current &&
        current.blocksNativeInput === blocksNativeInput &&
        current.nativeDimmingAlpha === nativeDimmingAlpha &&
        current.cutsNativeSurface === cutsNativeSurface &&
        current.dimHoleOnly === dimHoleOnly &&
        current.maskHoleOnly === maskHoleOnly &&
        sameRect(current.rect, nextRect)
      ) {
        return previous;
      }

      return {
        ...previous,
        [id]: {
          id,
          rect: nextRect,
          blocksNativeInput,
          nativeDimmingAlpha,
          cutsNativeSurface,
          dimHoleOnly,
          maskHoleOnly,
        },
      };
    });
  }, [
    blocksNativeInput,
    cutsNativeSurface,
    dimHoleOnly,
    maskHoleOnly,
    id,
    nativeDimmingAlpha,
    occlusionSlop,
    setRegistry,
    targetRef,
  ]);

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
    window.addEventListener("orgii-ui-scale-applied", schedulePublish);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePublish);
      window.removeEventListener("scroll", schedulePublish, true);
      window.removeEventListener("orgii-ui-scale-applied", schedulePublish);
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
