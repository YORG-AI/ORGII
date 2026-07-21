/**
 * ClampedContent
 *
 * Collapses long content to a fixed-height preview (~20 lines by default) with
 * the shared ExpandOverlay "Show more / less" pill — the same clamp policy
 * `AgentMessageBlock` applies to completed agent messages. Overflow is measured
 * against the real rendered height (ResizeObserver) rather than counting lines,
 * so markdown, wrapping, and late-loading content all clamp correctly.
 *
 * The collapse fade must dissolve into the surrounding surface: pass `fadeFrom`
 * as the Tailwind `from-*` class for the parent background (defaults to the
 * neutral bubble fill, `from-fill-2`).
 */
import React, { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import ExpandOverlay from "./ExpandOverlay";

/** Collapsed preview height in px — ~20 lines, matching AgentMessageBlock. */
export const CLAMPED_CONTENT_MAX_HEIGHT = 480;

/**
 * Compact preview height in px — ~5 lines at the 13px/`leading-relaxed`
 * bubble body. Used by avatar chat bubbles (subagent, agent-org group chat)
 * so long messages fold sooner than the full 20-line message clamp.
 */
export const CLAMPED_CONTENT_COMPACT_MAX_HEIGHT = 112;

export interface ClampedContentProps {
  children: React.ReactNode;
  /** Collapsed preview height in px (default {@link CLAMPED_CONTENT_MAX_HEIGHT}). */
  maxHeight?: number;
  /** Tailwind `from-*` class matching the surrounding background for the fade. */
  fadeFrom?: string;
  /** When false, renders children flush with no clamp (default true). */
  enabled?: boolean;
  /** Extra classes applied to the clamped viewport. */
  className?: string;
}

const ClampedContent: React.FC<ClampedContentProps> = ({
  children,
  maxHeight = CLAMPED_CONTENT_MAX_HEIGHT,
  fadeFrom = "from-fill-2",
  enabled = true,
  className = "",
}) => {
  const { t } = useTranslation("common");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset clamp-derived state during render whenever `enabled` flips (React's
  // "adjust state during render" pattern) so toggling the clamp always
  // restarts collapsed with no stale overflow signal.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (prevEnabled !== enabled) {
    setPrevEnabled(enabled);
    if (isExpanded) setIsExpanded(false);
    if (overflows) setOverflows(false);
  }

  // Measure the real content height against the preview height and re-measure
  // on reflow (markdown re-render, image load) so the pill appears as soon as
  // content overflows. Compare against scrollHeight — not clientHeight — to
  // avoid sub-pixel line-height rounding false-positiving single-line content.
  useLayoutEffect(() => {
    if (!enabled) return;
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > maxHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled, isExpanded, maxHeight]);

  if (!enabled) {
    return <div className={className}>{children}</div>;
  }

  const showOverlay = overflows || isExpanded;
  return (
    <div
      ref={viewportRef}
      className={`group/expand relative scrollbar-hide ${className}`.trim()}
      style={
        isExpanded
          ? { maxHeight: "none", overflow: "visible" }
          : { maxHeight, overflow: "hidden" }
      }
    >
      {children}
      {showOverlay && (
        <ExpandOverlay
          isExpanded={isExpanded}
          onToggle={(event) => {
            event.stopPropagation();
            setIsExpanded((prev) => !prev);
          }}
          collapsedLabel={t("actions.expand")}
          expandedLabel={t("actions.collapse")}
          fadeFrom={fadeFrom}
          showLabel
        />
      )}
    </div>
  );
};

export default React.memo(ClampedContent);
