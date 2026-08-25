import type { OverlayOcclusionRect } from "@src/store/ui/overlayLayerAtom";

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
  nativeFrameScale: number
): NativeWebviewOcclusionRect[] {
  if (
    !Number.isFinite(nativeFrameScale) ||
    nativeFrameScale <= 0 ||
    surface.right <= surface.left ||
    surface.bottom <= surface.top
  ) {
    return [];
  }

  const nativeSurfaceLeft = Math.round(surface.left * nativeFrameScale);
  const nativeSurfaceTop = Math.round(surface.top * nativeFrameScale);
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

    const left = Math.max(surface.left, overlay.x);
    const top = Math.max(surface.top, overlay.y);
    const right = Math.min(surface.right, overlay.x + overlay.width);
    const bottom = Math.min(surface.bottom, overlay.y + overlay.height);
    if (right <= left || bottom <= top) continue;

    const nativeLeft = Math.round(left * nativeFrameScale);
    const nativeTop = Math.round(top * nativeFrameScale);
    const nativeRight = Math.round(right * nativeFrameScale);
    const nativeBottom = Math.round(bottom * nativeFrameScale);

    intersections.push({
      x: nativeLeft - nativeSurfaceLeft,
      y: nativeTop - nativeSurfaceTop,
      width: nativeRight - nativeLeft,
      height: nativeBottom - nativeTop,
    });
  }

  return coalesceOcclusionRects(
    intersections.filter((rect) => rect.width > 0 && rect.height > 0)
  );
}
