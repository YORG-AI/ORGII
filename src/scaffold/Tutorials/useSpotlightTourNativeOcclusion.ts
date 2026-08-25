import { type RefObject } from "react";

import { useOverlayLayer } from "@src/store/ui/overlayLayerAtom";

/** Matches `bg-black/30` tour scrim on the live native browser surface. */
export const SPOTLIGHT_TOUR_NATIVE_DIMMING_ALPHA = 0.3;

/** Matches the guide highlight box-shadow scrim (`rgba(0,0,0,0.42)`). */
export const GUIDE_HIGHLIGHT_NATIVE_DIMMING_ALPHA = 0.42;

export interface SpotlightTourNativeOcclusionOptions {
  dimmingAlpha?: number;
}

/**
 * Spotlight tours render a cut-out scrim in React, but the inline browser is a
 * sibling native surface. Mirror the scrim on the live page with a uniform dim
 * layer. The step popover gets a WebView mask hole only so React can paint
 * above the live page without undimming GitHub underneath.
 *
 * Highlight cut-outs stay React-only: native dim holes would reveal bright page
 * content instead of the targeted chrome control.
 */
export function useSpotlightTourNativeOcclusion(
  active: boolean,
  popoverRef: RefObject<HTMLElement | null>,
  _highlightRef: RefObject<HTMLElement | null>,
  options: SpotlightTourNativeOcclusionOptions = {}
): void {
  const dimmingAlpha =
    options.dimmingAlpha ?? SPOTLIGHT_TOUR_NATIVE_DIMMING_ALPHA;

  useOverlayLayer(active, undefined, {
    nativeDimmingAlpha: dimmingAlpha,
    cutsNativeSurface: false,
  });
  useOverlayLayer(active, popoverRef, {
    maskHoleOnly: true,
    occlusionSlop: 12,
  });
}
