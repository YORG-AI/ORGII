export interface RectEdges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ClippingRect {
  rect: RectEdges;
  clipX: boolean;
  clipY: boolean;
}

const CLIPPING_OVERFLOW_VALUES = new Set([
  "auto",
  "clip",
  "hidden",
  "overlay",
  "scroll",
]);

function hasValidHorizontalEdges(rect: RectEdges): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.right) &&
    rect.right > rect.left
  );
}

function hasValidVerticalEdges(rect: RectEdges): boolean {
  return (
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.bottom) &&
    rect.bottom > rect.top
  );
}

function hasPositiveArea(rect: RectEdges): boolean {
  return hasValidHorizontalEdges(rect) && hasValidVerticalEdges(rect);
}

function createDomRect(rect: RectEdges): DOMRect {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;

  return {
    x: rect.left,
    y: rect.top,
    width,
    height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    toJSON: () => ({
      x: rect.left,
      y: rect.top,
      width,
      height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    }),
  };
}

/**
 * Intersects an anchor with the viewport and every ancestor overflow clip.
 *
 * Ancestors clip each axis independently because CSS can make only one of
 * `overflow-x` and `overflow-y` scrollable. Invalid or zero-area bounds fail
 * closed so a native child WebView is never positioned outside a known-safe
 * visible region.
 */
export function computeVisibleWebviewRect(
  anchorRect: RectEdges,
  viewportRect: RectEdges,
  clippingAncestors: readonly ClippingRect[] = []
): DOMRect | null {
  if (!hasPositiveArea(anchorRect) || !hasPositiveArea(viewportRect)) {
    return null;
  }

  const visible: RectEdges = {
    left: Math.max(anchorRect.left, viewportRect.left),
    top: Math.max(anchorRect.top, viewportRect.top),
    right: Math.min(anchorRect.right, viewportRect.right),
    bottom: Math.min(anchorRect.bottom, viewportRect.bottom),
  };

  if (!hasPositiveArea(visible)) return null;

  for (const ancestor of clippingAncestors) {
    if (ancestor.clipX) {
      if (!hasValidHorizontalEdges(ancestor.rect)) return null;
      visible.left = Math.max(visible.left, ancestor.rect.left);
      visible.right = Math.min(visible.right, ancestor.rect.right);
    }

    if (ancestor.clipY) {
      if (!hasValidVerticalEdges(ancestor.rect)) return null;
      visible.top = Math.max(visible.top, ancestor.rect.top);
      visible.bottom = Math.min(visible.bottom, ancestor.rect.bottom);
    }

    if (!hasPositiveArea(visible)) return null;
  }

  return createDomRect(visible);
}

function clipsOverflow(value: string): boolean {
  return CLIPPING_OVERFLOW_VALUES.has(value.trim().toLowerCase());
}

function getAncestorClipRect(element: Element): RectEdges {
  const rect = element.getBoundingClientRect();
  const offsetWidth =
    element instanceof HTMLElement ? element.offsetWidth : undefined;
  const offsetHeight =
    element instanceof HTMLElement ? element.offsetHeight : undefined;

  // Overflow clips at the padding edge. When layout dimensions are available,
  // convert the client box into viewport coordinates and preserve any uniform
  // scale applied by a transformed ancestor.
  if (
    offsetWidth &&
    offsetHeight &&
    Number.isFinite(element.clientWidth) &&
    Number.isFinite(element.clientHeight)
  ) {
    const scaleX = rect.width / offsetWidth;
    const scaleY = rect.height / offsetHeight;
    const trailingBorderX =
      offsetWidth - element.clientLeft - element.clientWidth;
    const trailingBorderY =
      offsetHeight - element.clientTop - element.clientHeight;

    return {
      left: rect.left + element.clientLeft * scaleX,
      top: rect.top + element.clientTop * scaleY,
      right: rect.right - trailingBorderX * scaleX,
      bottom: rect.bottom - trailingBorderY * scaleY,
    };
  }

  return rect;
}

function getViewportRect(): RectEdges {
  return {
    left: 0,
    top: 0,
    right: document.documentElement.clientWidth || window.innerWidth,
    bottom: document.documentElement.clientHeight || window.innerHeight,
  };
}

/**
 * Measures the portion of an element that can safely be occupied by a native
 * inline WebView in the current document viewport.
 */
export function getVisibleWebviewRect(anchor: Element): DOMRect | null {
  const clippingAncestors: ClippingRect[] = [];

  let ancestor = anchor.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const clipX = clipsOverflow(style.overflowX || style.overflow);
    const clipY = clipsOverflow(style.overflowY || style.overflow);

    if (clipX || clipY) {
      clippingAncestors.push({
        rect: getAncestorClipRect(ancestor),
        clipX,
        clipY,
      });
    }

    ancestor = ancestor.parentElement;
  }

  return computeVisibleWebviewRect(
    anchor.getBoundingClientRect(),
    getViewportRect(),
    clippingAncestors
  );
}
