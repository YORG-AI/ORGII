/**
 * Floating-window geometry helpers.
 *
 * A floating window is the nearest ancestor carrying `data-draggable-window`.
 * All geometry state lives on that DOM element itself (dataset + inline
 * style), never in React state: drag and resize both mutate one element's
 * style imperatively, so interactions never re-render the tree and the two
 * hooks can't drift out of sync — whichever runs next reads the element.
 *
 * Two positioning modes:
 *
 *   1. Fluid (initial): the window keeps its CSS layout (e.g. bottom-anchored
 *      `mx-auto w-full max-h-[...]`) and dragging offsets it with a transform.
 *   2. Pinned (after the first resize): the window is converted in place to
 *      explicit `position:absolute` + px geometry so edge/corner resizing can
 *      move one edge without CSS centering moving the opposite one. Dragging
 *      keeps working unchanged — it still just accumulates a transform.
 */

export const FLOATING_WINDOW_ATTR = "data-draggable-window";

export interface WindowOffset {
  x: number;
  y: number;
}

export function findFloatingWindow(from: HTMLElement): HTMLElement | null {
  return from.closest<HTMLElement>(`[${FLOATING_WINDOW_ATTR}]`);
}

export interface WindowBounds {
  /** Content-box edges in viewport coordinates (for drag clamps). */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /**
   * Content-box edges relative to the overlay's padding box — the space
   * absolute `left`/`top` resolve in (for pinned resize / re-fit clamps).
   */
  minLeft: number;
  minTop: number;
  maxRight: number;
  maxBottom: number;
}

/**
 * The area a floating window may occupy: its overlay's CONTENT box.
 * `getBoundingClientRect()` alone returns the border box, which would let
 * the window slide over the overlay's padding and touch the outer edge — the
 * overlay's padding IS the edge margin, so it is subtracted here for drag,
 * resize and re-fit clamps alike.
 */
export function readWindowBounds(win: HTMLElement): WindowBounds | null {
  const overlay = win.parentElement;
  if (!overlay) return null;
  const rect = overlay.getBoundingClientRect();
  const style = getComputedStyle(overlay);
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const padBottom = Number.parseFloat(style.paddingBottom) || 0;
  return {
    left: rect.left + padLeft,
    top: rect.top + padTop,
    right: rect.right - padRight,
    bottom: rect.bottom - padBottom,
    minLeft: padLeft,
    minTop: padTop,
    maxRight: rect.width - padRight,
    maxBottom: rect.height - padBottom,
  };
}

export function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function readWindowOffset(win: HTMLElement): WindowOffset {
  const x = Number.parseFloat(win.dataset.fwOffsetX ?? "");
  const y = Number.parseFloat(win.dataset.fwOffsetY ?? "");
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

export function applyWindowOffset(
  win: HTMLElement,
  offset: WindowOffset
): void {
  win.dataset.fwOffsetX = String(offset.x);
  win.dataset.fwOffsetY = String(offset.y);
  win.style.transform =
    offset.x === 0 && offset.y === 0
      ? ""
      : `translate3d(${offset.x}px, ${offset.y}px, 0)`;
}

export function isWindowPinned(win: HTMLElement): boolean {
  return win.dataset.fwPinned === "true";
}

/**
 * Convert the window to explicit absolute geometry at its current visual
 * position, folding any drag transform into `left`/`top`. Safe to call
 * repeatedly — each call re-bases on the current rect. The parent overlay is
 * the containing block (it is `position:absolute` itself); absolute
 * `left`/`top` resolve against its padding-box edge, and the resize / re-fit
 * clamps constrain them to `readWindowBounds`' `minLeft..maxRight` range.
 */
export function pinWindow(win: HTMLElement): void {
  const overlayRect = win.parentElement?.getBoundingClientRect();
  if (!overlayRect) return;
  const rect = win.getBoundingClientRect();
  win.style.position = "absolute";
  win.style.left = `${rect.left - overlayRect.left}px`;
  win.style.top = `${rect.top - overlayRect.top}px`;
  win.style.width = `${rect.width}px`;
  win.style.height = `${rect.height}px`;
  win.style.margin = "0";
  win.style.maxWidth = "none";
  win.style.maxHeight = "none";
  applyWindowOffset(win, { x: 0, y: 0 });
  win.dataset.fwPinned = "true";
}

/**
 * Re-fit a pinned window into its overlay after the overlay itself resized
 * (app window resize, sidebar toggle). Shrinks first, then shifts, so the
 * window can never be stranded outside the visible area. Fluid windows
 * already follow the container through CSS and are left alone.
 */
export function fitPinnedWindow(
  win: HTMLElement,
  minWidth: number,
  minHeight: number
): void {
  if (!isWindowPinned(win)) return;
  const bounds = readWindowBounds(win);
  if (!bounds) return;
  const availWidth = bounds.maxRight - bounds.minLeft;
  const availHeight = bounds.maxBottom - bounds.minTop;
  if (availWidth <= 0 || availHeight <= 0) return;

  // Fold any drag transform accumulated since the pin into `left`/`top`,
  // so the clamps below act on the window's real visual position.
  pinWindow(win);

  const width = clamp(
    Number.parseFloat(win.style.width) || 0,
    minWidth,
    availWidth
  );
  const height = clamp(
    Number.parseFloat(win.style.height) || 0,
    minHeight,
    availHeight
  );
  const left = clamp(
    Number.parseFloat(win.style.left) || 0,
    bounds.minLeft,
    bounds.maxRight - width
  );
  const top = clamp(
    Number.parseFloat(win.style.top) || 0,
    bounds.minTop,
    bounds.maxBottom - height
  );

  win.style.width = `${width}px`;
  win.style.height = `${height}px`;
  win.style.left = `${left}px`;
  win.style.top = `${top}px`;
}
