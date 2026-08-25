import type { OverlayOcclusionRect } from "@src/store/ui/overlayLayerAtom";
import { toNativeFrameFromCorners } from "@src/util/platform/tauri/nativeFrame";

export interface NativeWebviewOcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MAX_OCCLUSION_RECTS = 64;
const DEFAULT_HOLE_INFLATION_CSS = 4;
const MODAL_HOLE_INFLATION_CSS = 16;

export { DEFAULT_HOLE_INFLATION_CSS, MODAL_HOLE_INFLATION_CSS };

function inflateViewportRect(
  rect: ViewportRect,
  inflationCss: number
): ViewportRect {
  if (inflationCss <= 0) return rect;
  return {
    left: rect.left - inflationCss,
    top: rect.top - inflationCss,
    right: rect.right + inflationCss,
    bottom: rect.bottom + inflationCss,
  };
}

function clampViewportRectToSurface(
  rect: ViewportRect,
  surface: ViewportRect
): ViewportRect | null {
  const left = Math.max(surface.left, rect.left);
  const top = Math.max(surface.top, rect.top);
  const right = Math.min(surface.right, rect.right);
  const bottom = Math.min(surface.bottom, rect.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function overlapsOrTouches(
  left: NativeWebviewOcclusionRect,
  right: NativeWebviewOcclusionRect
): boolean {
  return !(
    left.x + left.width < right.x ||
    right.x + right.width < left.x ||
    left.y + left.height < right.y ||
    right.y + right.height < left.y
  );
}

function mergeRects(
  left: NativeWebviewOcclusionRect,
  right: NativeWebviewOcclusionRect
): NativeWebviewOcclusionRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const rightEdge = Math.max(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: rightEdge - x, height: bottomEdge - y };
}

/**
 * CAShapeLayer's even-odd rule treats overlapping hole paths as XOR. Merge
 * intersecting rectangles first so the overlap cannot become visible again.
 * The bounding rectangle is deliberately conservative: hiding a few extra
 * pixels is safer than letting a native surface paint over React UI.
 */
export function coalesceOcclusionRects(
  rects: readonly NativeWebviewOcclusionRect[]
): NativeWebviewOcclusionRect[] {
  const merged: NativeWebviewOcclusionRect[] = [];

  for (const source of rects.slice(0, MAX_OCCLUSION_RECTS)) {
    let candidate = source;
    let index = 0;
    while (index < merged.length) {
      if (!overlapsOrTouches(candidate, merged[index])) {
        index += 1;
        continue;
      }
      candidate = mergeRects(candidate, merged[index]);
      merged.splice(index, 1);
      index = 0;
    }
    merged.push(candidate);
  }

  return merged;
}

/** Convert viewport CSS rectangles into WebView-local native logical points. */
export function computeNativeWebviewOcclusions(
  surface: ViewportRect,
  overlays: readonly OverlayOcclusionRect[],
  nativeFrameScale: number,
  options: { holeInflationCss?: number } = {}
): NativeWebviewOcclusionRect[] {
  if (
    !Number.isFinite(nativeFrameScale) ||
    nativeFrameScale <= 0 ||
    surface.right <= surface.left ||
    surface.bottom <= surface.top
  ) {
    return [];
  }

  const holeInflationCss = Math.max(0, options.holeInflationCss ?? 0);
  const nativeSurface = toNativeFrameFromCorners(
    {
      left: surface.left,
      top: surface.top,
      right: surface.right,
      bottom: surface.bottom,
    },
    nativeFrameScale
  );
  const nativeSurfaceRight = nativeSurface.x + nativeSurface.width;
  const nativeSurfaceBottom = nativeSurface.y + nativeSurface.height;
  const intersections: NativeWebviewOcclusionRect[] = [];

  for (const overlay of overlays.slice(0, MAX_OCCLUSION_RECTS)) {
    if (
      !Number.isFinite(overlay.x) ||
      !Number.isFinite(overlay.y) ||
      !Number.isFinite(overlay.width) ||
      !Number.isFinite(overlay.height) ||
      overlay.width <= 0 ||
      overlay.height <= 0
    ) {
      continue;
    }

    const overlayViewport = inflateViewportRect(
      {
        left: overlay.x,
        top: overlay.y,
        right: overlay.x + overlay.width,
        bottom: overlay.y + overlay.height,
      },
      holeInflationCss
    );
    const intersection = clampViewportRectToSurface(overlayViewport, surface);
    if (!intersection) continue;

    const nativeOverlay = toNativeFrameFromCorners(
      intersection,
      nativeFrameScale
    );
    const left = Math.max(nativeSurface.x, nativeOverlay.x);
    const top = Math.max(nativeSurface.y, nativeOverlay.y);
    const right = Math.min(
      nativeSurfaceRight,
      nativeOverlay.x + nativeOverlay.width
    );
    const bottom = Math.min(
      nativeSurfaceBottom,
      nativeOverlay.y + nativeOverlay.height
    );
    if (right <= left || bottom <= top) continue;

    intersections.push({
      x: left - nativeSurface.x,
      y: top - nativeSurface.y,
      width: right - left,
      height: bottom - top,
    });
  }

  return coalesceOcclusionRects(
    intersections.filter((rect) => rect.width > 0 && rect.height > 0)
  );
}
