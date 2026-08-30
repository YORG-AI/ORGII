/**
 * CanvasInlineCard — Agent-generated interactive preview embedded in chat.
 *
 * Renders a card directly in the message stream. Four modes:
 *   html  — sanitized HTML rendered in Shadow DOM
 *   url   — external URL shown as an open action, not embedded
 *   a2ui  — incremental JSONL stream rendered as native React components
 *   react — generated React App source compiled and executed in a sandboxed
 *           canvas-artifact iframe (ReactArtifactRunner)
 *
 * For a2ui mode the previous iframe + postMessage approach has been replaced
 * with A2UIRenderer, which receives the parsed lines directly as props and
 * re-renders incrementally without any full reload.
 *
 * Security:
 *   - html path: DOMPurify + Shadow DOM, no scripts/events
 *   - url: not embedded to avoid iframe memory overhead
 *   - a2ui: DOMPurify sanitizes type="html" elements in A2UIRenderer
 */
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon, Layout01Icon } from "@src/icons";

import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";
import CanvasPreviewSurface, {
  type CanvasPreviewSurfaceHandle,
} from "./CanvasPreviewSurface";
import type { CanvasInlineCardProps } from "./types";

// ─── height steps ─────────────────────────────────────────────────────────────

const HEIGHT_STEPS = [240, 400, 580] as const;

function resolveInitialStep(initialHeight: number): number {
  const idx = HEIGHT_STEPS.findIndex((h) => h >= initialHeight);
  return idx >= 0 ? idx : 0;
}

// ─── loading skeleton ─────────────────────────────────────────────────────────

/**
 * Skeleton placeholder shown while the A2UI stream has not yet produced any
 * parseable elements. Mirrors a plausible canvas card layout: heading bar,
 * content lines, and a chart/table rectangle — all in the card's dark theme
 * using design-system fill tokens.
 */
const CanvasLoadingSkeleton: React.FC = () => (
  <div
    className="flex h-full flex-col gap-3 p-4"
    aria-busy="true"
    aria-label="Loading canvas content"
  >
    {/* Heading bar — ~60% width */}
    <div className="h-4 w-3/5 animate-pulse rounded bg-fill-3" />

    {/* Content lines — varying widths */}
    <div className="flex flex-col gap-2">
      <div className="h-3 w-full animate-pulse rounded bg-fill-3" />
      <div className="h-3 w-[85%] animate-pulse rounded bg-fill-3" />
      <div className="h-3 w-[70%] animate-pulse rounded bg-fill-3" />
    </div>

    {/* Chart / table placeholder rectangle */}
    <div className="mt-1 h-24 w-full animate-pulse rounded-md bg-fill-3" />
  </div>
);

// ─── main component ───────────────────────────────────────────────────────────

const CanvasInlineCard: React.FC<CanvasInlineCardProps> = ({
  mode,
  content,
  url,
  title,
  initialHeight = 280,
  isStreaming = false,
  eventId,
  sessionId,
  onAction,
}) => {
  const { t } = useTranslation("sessions");

  const [heightStep] = useState(() => resolveInitialStep(initialHeight));
  const rendererRef = useRef<CanvasPreviewSurfaceHandle>(null);
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleLocate,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: false,
    eventId,
    collapseAllValue: true,
  });

  const currentHeight = HEIGHT_STEPS[heightStep % HEIGHT_STEPS.length];

  const simulatorPayload = useMemo(
    () => ({ mode, content, url, title, streaming: isStreaming }),
    [mode, content, url, title, isStreaming]
  );

  const cardTitle =
    title ??
    (mode === "url"
      ? t("canvasCard.titleUrl")
      : mode === "a2ui"
        ? t("canvasCard.titleA2ui")
        : mode === "react"
          ? t("canvasCard.titleReact", "React Preview")
          : t("canvasCard.titleHtml"));

  const headerSubtitle = isStreaming
    ? t("canvasCard.streaming", "streaming")
    : mode === "url" && url
      ? url
      : undefined;

  const emptyFallback = (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-text-4">{t("canvasCard.empty")}</span>
    </div>
  );

  const contentArea = (
    <CanvasPreviewSurface
      ref={rendererRef}
      payload={simulatorPayload}
      variant="inline"
      title={cardTitle}
      loadingFallback={<CanvasLoadingSkeleton />}
      emptyFallback={emptyFallback}
      sessionId={sessionId}
      onAction={onAction}
    />
  );

  return (
    <div className={`group/canvas ${getEventBlockContainerClasses()}`}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        className={
          isCollapsed
            ? "border-b border-solid border-transparent"
            : "border-b border-solid border-border-1"
        }
        onClick={handleHeaderClick}
        onNavigate={eventId ? handleLocate : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        withHover
      >
        <EventBlockHeaderIcon
          icon={
            <HugeiconsIcon
              icon={Layout01Icon}
              data-icon="panels-top-left"
              size={14}
              className="text-primary-6"
            />
          }
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent
        />
        <EventBlockHeaderTitle>{cardTitle}</EventBlockHeaderTitle>
        {headerSubtitle && (
          <EventBlockHeaderSubtitle title={headerSubtitle}>
            {headerSubtitle}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {!isCollapsed && (
        <div
          className="relative w-full overflow-hidden transition-[height] duration-300 ease-in-out"
          style={{ height: currentHeight }}
        >
          <div className="h-full min-w-0 max-w-full">{contentArea}</div>

          {/* Streaming progress bar — pulsing accent line at bottom edge */}
          {isStreaming && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary-6/40"
              aria-hidden
            />
          )}
        </div>
      )}
    </div>
  );
};

CanvasInlineCard.displayName = "CanvasInlineCard";

const CanvasInlineCardWithBoundary: React.FC<CanvasInlineCardProps> = (
  props
) => (
  <CanvasErrorBoundary>
    <CanvasInlineCard {...props} />
  </CanvasErrorBoundary>
);
CanvasInlineCardWithBoundary.displayName = "CanvasInlineCardWithBoundary";

export default CanvasInlineCardWithBoundary;
export type { CanvasInlineCardProps } from "./types";
