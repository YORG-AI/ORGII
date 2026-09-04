import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
} from "react";

import { type TrailPanelSize, resizeTrailPanel } from "./trailPanelSize";

interface TrailPanelResizeOptions {
  min: TrailPanelSize;
  max: TrailPanelSize;
  onResize: (size: TrailPanelSize) => void;
  onResizeEnd: (size: TrailPanelSize) => void;
  onResizingChange: (resizing: boolean) => void;
}

/** One drag owner for in-flow, right-anchored trail panels (not floating windows). */
export function useTrailPanelResize(options: TrailPanelResizeOptions) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const readGeometry = (handle: HTMLElement) => {
    const panel = handle.closest<HTMLElement>("[data-workstation-trail-panel]");
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    if (
      !panel.offsetWidth ||
      !panel.offsetHeight ||
      !rect.width ||
      !rect.height
    ) {
      return null;
    }
    const scaleX = rect.width / panel.offsetWidth;
    const scaleY = rect.height / panel.offsetHeight;
    const track = panel.closest<HTMLElement>("[data-workstation-trail-track]");
    // Read layout only at the beginning of an interaction. Leave room for a
    // docked sibling below this panel, and for the track's bottom padding.
    let availableHeight = options.max.height;
    if (track) {
      let followingHeight = 0;
      let sibling = panel.nextElementSibling;
      while (sibling) {
        if (sibling instanceof HTMLElement) {
          const style = getComputedStyle(sibling);
          followingHeight += sibling.getBoundingClientRect().height / scaleY;
          followingHeight +=
            (Number.parseFloat(style.marginTop) || 0) +
            (Number.parseFloat(style.marginBottom) || 0);
        }
        sibling = sibling.nextElementSibling;
      }
      availableHeight =
        (track.getBoundingClientRect().bottom - rect.top) / scaleY -
        followingHeight -
        (Number.parseFloat(getComputedStyle(track).paddingBottom) || 0);
    }
    if (availableHeight <= 0) return null;
    return {
      size: { width: panel.offsetWidth, height: panel.offsetHeight },
      scaleX,
      scaleY,
      max: {
        ...options.max,
        height: Math.min(options.max.height, availableHeight),
      },
    };
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const geometry = readGeometry(event.currentTarget);
    if (!geometry) return;
    event.preventDefault();
    event.stopPropagation();
    cleanupRef.current?.();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let latestX = startX;
    let latestY = startY;
    let size = geometry.size;
    let frame: number | null = null;
    let moved = false;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    const apply = () => {
      frame = null;
      const nextSize = resizeTrailPanel(
        geometry.size,
        {
          width: (latestX - startX) / geometry.scaleX,
          height: (latestY - startY) / geometry.scaleY,
        },
        options.min,
        geometry.max
      );
      if (nextSize.width !== size.width || nextSize.height !== size.height) {
        size = nextSize;
        options.onResize(size);
      }
    };
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      latestX = next.clientX;
      latestY = next.clientY;
      moved = true;
      if (frame === null) frame = requestAnimationFrame(apply);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      cleanupRef.current = null;
      options.onResizingChange(false);
    };
    const commit = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        apply();
      }
      cleanup();
      if (moved) options.onResizeEnd(size);
    };
    const finish = (last: globalThis.PointerEvent) => {
      if (last.pointerId !== pointerId) return;
      if (moved || last.clientX !== startX || last.clientY !== startY)
        move(last);
      commit();
    };
    const cancel = () => commit();
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointerId) cancel();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") cancel();
    };

    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.body.style.cursor = "nesw-resize";
    document.body.style.userSelect = "none";
    options.onResizingChange(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 40 : 10;
    const delta = {
      ArrowLeft: { width: -step, height: 0 },
      ArrowRight: { width: step, height: 0 },
      ArrowUp: { width: 0, height: -step },
      ArrowDown: { width: 0, height: step },
    }[event.key];
    if (!delta) return;
    const geometry = readGeometry(event.currentTarget);
    if (!geometry) return;
    event.preventDefault();
    event.stopPropagation();
    const size = resizeTrailPanel(
      geometry.size,
      delta,
      options.min,
      geometry.max
    );
    options.onResize(size);
    options.onResizeEnd(size);
  };

  return { onPointerDown, onKeyDown };
}
