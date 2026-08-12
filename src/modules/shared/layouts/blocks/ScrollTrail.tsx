import React, {
  type HTMLAttributes,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";

export const MAX_SCROLL_TRAIL_MARKERS = 20;
export const SCROLL_TRAIL_TARGET_SELECTOR = "[data-scroll-trail-target]";
const SCROLL_TRAIL_LABEL_ATTRIBUTE = "data-scroll-trail-label";
const SCROLL_BOTTOM_TOLERANCE_PX = 2;
const ACTIVE_ANCHOR_MAX_OFFSET_PX = 64;
const MAX_TRAIL_LABEL_LENGTH = 120;

interface ScrollTrailMarker {
  element: HTMLElement;
  label: string;
  targetIndex: number;
}

export type ScrollTrailPlacement = "overlay" | "rail";
export type ScrollTrailAlignment = "center" | "start";

export function sampleScrollTrailIndices(
  targetCount: number,
  maxMarkers = MAX_SCROLL_TRAIL_MARKERS
): number[] {
  if (targetCount <= 0 || maxMarkers <= 0) return [];
  if (targetCount <= maxMarkers) {
    return Array.from({ length: targetCount }, (_, index) => index);
  }
  if (maxMarkers === 1) return [targetCount - 1];

  const lastIndex = targetCount - 1;
  return Array.from({ length: maxMarkers }, (_, markerIndex) =>
    Math.round((markerIndex / (maxMarkers - 1)) * lastIndex)
  );
}

export function resolveActiveScrollTrailIndex({
  markerOffsets,
  scrollTop,
  clientHeight,
  scrollHeight,
}: {
  markerOffsets: readonly number[];
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}): number {
  if (markerOffsets.length === 0) return -1;

  const hasOverflow = scrollHeight > clientHeight + SCROLL_BOTTOM_TOLERANCE_PX;
  const isAtBottom =
    hasOverflow &&
    scrollHeight - clientHeight - scrollTop <= SCROLL_BOTTOM_TOLERANCE_PX;
  if (isAtBottom) return markerOffsets.length - 1;

  const activeAnchor =
    scrollTop +
    Math.min(ACTIVE_ANCHOR_MAX_OFFSET_PX, Math.max(0, clientHeight * 0.15));
  let activeIndex = 0;
  for (let index = 0; index < markerOffsets.length; index++) {
    if (markerOffsets[index] > activeAnchor) break;
    activeIndex = index;
  }
  return activeIndex;
}

export function getScrollTrailMarkerWidthClass(
  markerIndex: number,
  previewMarkerIndex: number
): string {
  if (previewMarkerIndex < 0) return "w-2";
  const distance = Math.abs(markerIndex - previewMarkerIndex);
  if (distance === 0) return "w-5";
  if (distance === 1) return "w-4";
  if (distance === 2) return "w-3";
  return "w-2";
}

export function normalizeScrollTrailLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_TRAIL_LABEL_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TRAIL_LABEL_LENGTH - 1).trimEnd()}…`;
}

export interface ScrollTrailTargetProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  enabled?: boolean;
}

/** Marks one semantic stop inside a scroll surface without owning navigation. */
export function ScrollTrailTarget({
  label,
  enabled = true,
  className = "",
  children,
  ...divProps
}: ScrollTrailTargetProps): React.ReactNode {
  if (!enabled) return <>{children}</>;

  return (
    <div
      {...divProps}
      data-scroll-trail-target
      data-scroll-trail-label={normalizeScrollTrailLabel(label)}
      className={`min-w-0 ${className}`.trim()}
    >
      {children}
    </div>
  );
}

export interface ScrollTrailProps {
  scrollContainerRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  ariaLabel: string;
  className?: string;
  alignment?: ScrollTrailAlignment;
  maxMarkers?: number;
  placement?: ScrollTrailPlacement;
  testId?: string;
}

function areMarkerListsEqual(
  current: readonly ScrollTrailMarker[],
  next: readonly ScrollTrailMarker[]
): boolean {
  return (
    current.length === next.length &&
    current.every(
      (marker, index) =>
        marker.element === next[index]?.element &&
        marker.label === next[index]?.label &&
        marker.targetIndex === next[index]?.targetIndex
    )
  );
}

/**
 * Compact semantic navigation for long detail surfaces.
 *
 * Target discovery is mutation-driven and scroll updates are coalesced to one
 * animation frame. The retained marker list is capped by `maxMarkers`.
 */
const ScrollTrail: React.FC<ScrollTrailProps> = ({
  scrollContainerRef,
  contentRef,
  ariaLabel,
  className = "",
  alignment = "center",
  maxMarkers = MAX_SCROLL_TRAIL_MARKERS,
  placement = "overlay",
  testId,
}) => {
  const { t } = useTranslation("common");
  const tooltipId = useId();
  const [markers, setMarkers] = useState<ScrollTrailMarker[]>([]);
  const markersRef = useRef<ScrollTrailMarker[]>([]);
  const [targetCount, setTargetCount] = useState(0);
  const [activeMarkerIndex, setActiveMarkerIndex] = useState(0);
  const [previewMarkerIndex, setPreviewMarkerIndex] = useState<number | null>(
    null
  );
  const frameRef = useRef<number | null>(null);

  const updateActiveMarker = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    const currentMarkers = markersRef.current;
    if (!scrollContainer || currentMarkers.length === 0) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const markerOffsets = currentMarkers.map(
      ({ element }) =>
        scrollContainer.scrollTop +
        element.getBoundingClientRect().top -
        containerRect.top
    );
    const nextActiveMarkerIndex = resolveActiveScrollTrailIndex({
      markerOffsets,
      scrollTop: scrollContainer.scrollTop,
      clientHeight: scrollContainer.clientHeight,
      scrollHeight: scrollContainer.scrollHeight,
    });
    setActiveMarkerIndex((current) =>
      current === nextActiveMarkerIndex ? current : nextActiveMarkerIndex
    );
  }, [scrollContainerRef]);

  const scheduleActiveMarkerUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updateActiveMarker();
    });
  }, [updateActiveMarker]);

  const refreshMarkers = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const discoveredTargets = Array.from(
      content.querySelectorAll<HTMLElement>(SCROLL_TRAIL_TARGET_SELECTOR)
    );
    // Keep the navigator useful on sparse/loading thread bodies. The content
    // root is a stable top destination until semantic stops are available.
    const targets =
      discoveredTargets.length > 0 ? discoveredTargets : [content];
    const sampledIndices = sampleScrollTrailIndices(targets.length, maxMarkers);
    const nextMarkers = sampledIndices.map((targetIndex) => {
      const element = targets[targetIndex];
      return {
        element,
        label:
          element.getAttribute(SCROLL_TRAIL_LABEL_ATTRIBUTE) ||
          (element === content ? ariaLabel : "") ||
          t("navigation.section", {
            defaultValue: "Section {{current}}",
            current: targetIndex + 1,
          }),
        targetIndex,
      };
    });

    markersRef.current = nextMarkers;
    setMarkers((current) =>
      areMarkerListsEqual(current, nextMarkers) ? current : nextMarkers
    );
    setTargetCount(targets.length);
    scheduleActiveMarkerUpdate();
  }, [ariaLabel, contentRef, maxMarkers, scheduleActiveMarkerUpdate, t]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const content = contentRef.current;
    if (!scrollContainer || !content) return;

    refreshMarkers();
    const mutationObserver = new MutationObserver(refreshMarkers);
    mutationObserver.observe(content, {
      attributes: true,
      attributeFilter: [SCROLL_TRAIL_LABEL_ATTRIBUTE],
      childList: true,
      subtree: true,
    });
    const resizeObserver = new ResizeObserver(scheduleActiveMarkerUpdate);
    resizeObserver.observe(scrollContainer);
    resizeObserver.observe(content);
    scrollContainer.addEventListener("scroll", scheduleActiveMarkerUpdate, {
      passive: true,
    });

    return () => {
      scrollContainer.removeEventListener("scroll", scheduleActiveMarkerUpdate);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [
    contentRef,
    refreshMarkers,
    scheduleActiveMarkerUpdate,
    scrollContainerRef,
  ]);

  const navigateToMarker = (marker: ScrollTrailMarker, markerIndex: number) => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetRect = marker.element.getBoundingClientRect();
    const top =
      scrollContainer.scrollTop + targetRect.top - containerRect.top - 12;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    setActiveMarkerIndex(markerIndex);
    scrollContainer.scrollTo({
      top: Math.max(0, top),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const placementClass =
    placement === "rail"
      ? "left-1/2 -translate-x-1/2"
      : "right-2 rounded-xl border border-border-2/60 bg-bg-1/90 px-1 py-2 shadow-sm backdrop-blur-sm";
  const alignmentClass =
    alignment === "start" ? "top-2" : "top-1/2 -translate-y-1/2";

  return (
    <nav
      aria-label={ariaLabel}
      data-testid={testId}
      className={`pointer-events-auto absolute z-40 flex w-9 flex-col items-center overflow-visible ${alignmentClass} ${placementClass} ${className}`.trim()}
      onMouseLeave={() => setPreviewMarkerIndex(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPreviewMarkerIndex(null);
        }
      }}
    >
      {markers.length === 0 ? (
        <div
          className="relative flex h-3 w-9 shrink-0 items-center justify-center"
          aria-hidden
        >
          <span className="h-[3px] w-2 shrink-0 bg-primary-6" />
        </div>
      ) : null}
      {markers.map((marker, markerIndex) => {
        const isActive = markerIndex === activeMarkerIndex;
        const widthClass = getScrollTrailMarkerWidthClass(
          markerIndex,
          previewMarkerIndex ?? -1
        );
        return (
          <div
            key={`${marker.targetIndex}-${marker.label}`}
            className="relative flex h-3 w-9 shrink-0 items-center justify-center"
          >
            <button
              type="button"
              aria-current={isActive ? "step" : undefined}
              aria-describedby={
                previewMarkerIndex === markerIndex ? tooltipId : undefined
              }
              aria-label={t("navigation.goToSection", {
                defaultValue:
                  "Go to {{label}}, section {{current}} of {{total}}",
                label: marker.label,
                current: marker.targetIndex + 1,
                total: targetCount,
              })}
              className="group flex h-3 w-9 cursor-pointer items-center justify-center border-0 bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30"
              onClick={() => navigateToMarker(marker, markerIndex)}
              onMouseEnter={() => setPreviewMarkerIndex(markerIndex)}
              onFocus={() => setPreviewMarkerIndex(markerIndex)}
            >
              <span
                className={`h-[3px] shrink-0 ${widthClass} transition-[width,background-color] duration-150 motion-reduce:transition-none ${
                  isActive
                    ? "bg-primary-6"
                    : "bg-text-3/40 group-hover:bg-primary-6 group-focus-visible:bg-primary-6"
                }`}
              />
            </button>

            {previewMarkerIndex === markerIndex ? (
              <div
                id={tooltipId}
                role="tooltip"
                className={`${DROPDOWN_CLASSES.panel} pointer-events-none absolute right-full top-1/2 mr-1 w-56 -translate-y-1/2 p-2.5 text-left`}
              >
                <div className="line-clamp-3 text-sm font-medium leading-5 text-text-1">
                  {marker.label}
                </div>
                <div className="mt-1 text-xs tabular-nums text-text-3">
                  {t("navigation.sectionPosition", {
                    defaultValue: "Section {{current}} of {{total}}",
                    current: marker.targetIndex + 1,
                    total: targetCount,
                  })}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
};

export default ScrollTrail;
