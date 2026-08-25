import { useSetAtom } from "jotai";
import React, { useEffect, useLayoutEffect, useRef } from "react";

import { getVisibleWebviewRect } from "@src/hooks/platform/useInlineWebview/visibleWebviewRect";
import { WEBVIEW_LAYOUT_CHANGED_EVENT } from "@src/hooks/platform/useInlineWebview/webviewLayoutEvents";

import {
  SHARED_BROWSER_HOST,
  SHARED_BROWSER_HOST_SCOPE,
  type SharedBrowserHostId,
  type SharedBrowserHostRect,
  type SharedBrowserHostScope,
  sharedBrowserHostRegistryAtom,
} from "./sharedBrowserHostAtoms";

interface SharedBrowserHostSlotProps {
  hostId: SharedBrowserHostId;
  scope?: SharedBrowserHostScope;
  active: boolean;
  className?: string;
  bottomInsetPx?: number;
  measureSelector?: string;
  children?: React.ReactNode;
}

function getDefaultScope(hostId: SharedBrowserHostId): SharedBrowserHostScope {
  return hostId === SHARED_BROWSER_HOST.AGENT_STATION
    ? SHARED_BROWSER_HOST_SCOPE.AGENT_STATION
    : SHARED_BROWSER_HOST_SCOPE.MY_STATION;
}

function toHostRect(
  visibleRect: DOMRect,
  measuredRect: DOMRect,
  bottomInsetPx: number
): SharedBrowserHostRect | null {
  const bottom = Math.min(
    visibleRect.bottom,
    measuredRect.bottom - bottomInsetPx
  );
  const height = bottom - visibleRect.top;
  if (visibleRect.width <= 0 || height <= 0) return null;

  return {
    x: visibleRect.x,
    y: visibleRect.y,
    width: visibleRect.width,
    height,
  };
}

function sameRect(
  left: SharedBrowserHostRect | null,
  right: SharedBrowserHostRect | null
): boolean {
  if (!left || !right) return left === right;
  return (
    Math.abs(left.x - right.x) < 1 &&
    Math.abs(left.y - right.y) < 1 &&
    Math.abs(left.width - right.width) < 1 &&
    Math.abs(left.height - right.height) < 1
  );
}

function getMeasureTarget(
  element: Element,
  measureSelector: string | undefined
): Element | null {
  if (!measureSelector) return element;
  return element.querySelector(measureSelector);
}

export const SharedBrowserHostSlot: React.FC<SharedBrowserHostSlotProps> = ({
  hostId,
  scope = getDefaultScope(hostId),
  active,
  className = "h-full w-full",
  bottomInsetPx = 0,
  measureSelector,
  children,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const setRegistry = useSetAtom(sharedBrowserHostRegistryAtom);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element) return;

    let animationFrame: number | null = null;
    let observedMeasureTarget: Element | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const syncObservedMeasureTarget = (): Element | null => {
      const nextTarget = getMeasureTarget(element, measureSelector);
      if (nextTarget === observedMeasureTarget) return nextTarget;

      if (observedMeasureTarget && observedMeasureTarget !== element) {
        resizeObserver?.unobserve(observedMeasureTarget);
      }

      observedMeasureTarget = nextTarget;
      if (nextTarget && nextTarget !== element) {
        resizeObserver?.observe(nextTarget);
      }

      return nextTarget;
    };

    const publish = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        const measureTarget = syncObservedMeasureTarget();
        const insetPx = measureTarget === element ? bottomInsetPx : 0;
        const nextRect = active
          ? measureTarget
            ? (() => {
                const visibleRect = getVisibleWebviewRect(measureTarget);
                return visibleRect
                  ? toHostRect(
                      visibleRect,
                      measureTarget.getBoundingClientRect(),
                      insetPx
                    )
                  : null;
              })()
            : null
          : null;
        setRegistry((prev) => {
          const current = prev[hostId];
          if (
            current.scope === scope &&
            current.active === active &&
            sameRect(current.rect, nextRect)
          ) {
            return prev;
          }
          return {
            ...prev,
            [hostId]: {
              id: hostId,
              scope,
              active,
              rect: nextRect,
            },
          };
        });
      });
    };

    resizeObserver = new ResizeObserver(publish);
    resizeObserver.observe(element);

    const mutationObserver = measureSelector
      ? new MutationObserver(publish)
      : null;
    mutationObserver?.observe(element, {
      childList: true,
      subtree: true,
    });

    publish();
    window.addEventListener("resize", publish);
    window.addEventListener("scroll", publish, true);
    window.addEventListener(WEBVIEW_LAYOUT_CHANGED_EVENT, publish);

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", publish);
      window.removeEventListener("scroll", publish, true);
      window.removeEventListener(WEBVIEW_LAYOUT_CHANGED_EVENT, publish);
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
    };
  }, [active, bottomInsetPx, hostId, measureSelector, scope, setRegistry]);

  useEffect(() => {
    return () => {
      setRegistry((prev) => ({
        ...prev,
        [hostId]: {
          id: hostId,
          scope,
          active: false,
          rect: null,
        },
      }));
    };
  }, [hostId, scope, setRegistry]);

  return (
    <div ref={hostRef} className={className}>
      {children}
    </div>
  );
};

export default SharedBrowserHostSlot;
