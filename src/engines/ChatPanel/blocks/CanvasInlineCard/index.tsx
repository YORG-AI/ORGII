/**
 * CanvasInlineCard — Agent-generated interactive preview embedded in chat.
 *
 * Renders a card directly in the message stream. Three modes:
 *   html  — static HTML from the agent, sandboxed iframe (security isolation)
 *   url   — external URL, sandboxed iframe with allow-same-origin
 *   a2ui  — incremental JSONL stream rendered as native React components
 *   react — React App component rendered in an iframe sandbox with runtime errors
 *
 * For a2ui mode the previous iframe + postMessage approach has been replaced
 * with A2UIRenderer, which receives the parsed lines directly as props and
 * re-renders incrementally without any full reload.
 *
 * Security:
 *   - html/react iframes: sandbox="allow-scripts" only (no allow-same-origin)
 *   - url iframes: allow-same-origin so cross-origin assets load correctly
 *   - a2ui: DOMPurify sanitizes type="html" elements in A2UIRenderer
 */
import { Layout, Monitor } from "lucide-react";
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import IconButton from "@src/components/IconButton";

import A2UIRenderer, { type A2UIRendererHandle } from "./A2UIRenderer";
import { CanvasErrorBoundary } from "./CanvasErrorBoundary";
import { buildHtmlDocument, buildReactDocument } from "./canvasBuilder";
import type { CanvasInlineCardProps } from "./types";
import { useJumpToSimulatorCanvas } from "./useJumpToSimulatorCanvas";

// ─── height steps ─────────────────────────────────────────────────────────────

const HEIGHT_STEPS = [240, 400, 580] as const;

function resolveInitialStep(initialHeight: number): number {
  const idx = HEIGHT_STEPS.findIndex((h) => h >= initialHeight);
  return idx >= 0 ? idx : 0;
}

// ─── A2UI JSONL splitter ──────────────────────────────────────────────────────

/**
 * Split a JSONL content string into individual element strings.
 *
 * Naïve `content.split("\n")` corrupts elements whose string fields contain
 * real newlines (e.g. `{"type":"code","content":"a\nb\nc"}`): the inner
 * newlines get treated as element separators, shredding one valid JSON record
 * into many invalid fragments. The a2ui core then throws
 * "Cannot create component el-N without a type".
 *
 * Strategy: walk physical lines, accumulating into a buffer. After each line
 * is appended, try `JSON.parse(buffer)`. On success → emit + reset. On
 * failure → keep accumulating, re-attaching the `\n` so multi-line string
 * values survive intact. Lines that never parse (truly malformed input) are
 * dropped at end-of-input.
 */
function splitA2UIContent(content: string): string[] {
  const result: string[] = [];
  const physicalLines = content.split("\n");
  let buffer = "";
  for (const line of physicalLines) {
    buffer = buffer.length === 0 ? line : `${buffer}\n${line}`;
    const trimmed = buffer.trim();
    if (trimmed.length === 0) {
      buffer = "";
      continue;
    }
    try {
      JSON.parse(trimmed);
      result.push(trimmed);
      buffer = "";
    } catch {
      // Incomplete JSON — keep accumulating across physical newlines.
    }
  }
  // Discard any trailing partial buffer (mid-stream chunk, not yet closed).
  return result;
}

// ─── streaming cursor ─────────────────────────────────────────────────────────

const StreamingDot: React.FC = () => (
  <span
    aria-hidden
    className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6"
  />
);

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
  sessionId,
  onAction,
}) => {
  const { t } = useTranslation("sessions");

  const [heightStep] = useState(() => resolveInitialStep(initialHeight));
  const rendererRef = useRef<A2UIRendererHandle>(null);

  const currentHeight = HEIGHT_STEPS[heightStep % HEIGHT_STEPS.length];

  // Split A2UI content into individual JSONL elements — React state update on
  // each streaming chunk causes A2UIRenderer to diff only new elements.
  //
  // We can't naïvely split on "\n": elements like `code` carry multi-line
  // content whose real newlines must not be treated as JSONL separators
  // (otherwise the element JSON gets shredded and the a2ui core throws
  // "Cannot create component el-N without a type"). Instead, scan
  // line-by-line and only emit a JSONL element once the accumulated buffer
  // parses as a complete JSON value.
  const a2uiLines = useMemo(() => {
    if (mode !== "a2ui" || !content) return [];
    return splitA2UIContent(content);
  }, [mode, content]);

  // Build the srcDoc only for html mode. For a2ui mode we no longer generate
  // a document — native React handles the incremental rendering.
  const htmlSrcDoc = useMemo(() => {
    if (mode === "html" && content) return buildHtmlDocument(content);
    return undefined;
  }, [mode, content]);

  const reactSrcDoc = useMemo(() => {
    if (mode === "react" && content) return buildReactDocument(content);
    return undefined;
  }, [mode, content]);

  const simulatorPayload = useMemo(
    () => ({ mode, content, url, title, streaming: isStreaming }),
    [mode, content, url, title, isStreaming]
  );
  const handleJumpToSimulator = useJumpToSimulatorCanvas(
    sessionId,
    simulatorPayload
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

  // ── render content area ───────────────────────────────────────────────────

  let contentArea: React.ReactNode;

  if (mode === "url" && url) {
    contentArea = (
      <iframe
        src={url}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={cardTitle}
      />
    );
  } else if (mode === "html" && htmlSrcDoc) {
    // HTML mode: still uses iframe for sandboxed security isolation.
    // Setting key={htmlSrcDoc.length} avoids full reload on every char — the
    // document only reloads when the content length changes by a meaningful
    // amount (streaming updates to existing content are stable here since the
    // agent typically sends the full document in one shot for html mode).
    contentArea = (
      <iframe
        srcDoc={htmlSrcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts"
        title={cardTitle}
      />
    );
  } else if (mode === "react" && reactSrcDoc) {
    contentArea = (
      <iframe
        srcDoc={reactSrcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts"
        title={cardTitle}
      />
    );
  } else if (mode === "a2ui" && isStreaming && a2uiLines.length === 0) {
    // Full skeleton: stream started but no JSONL elements parsed yet.
    contentArea = <CanvasLoadingSkeleton />;
  } else if (mode === "a2ui" && a2uiLines.length > 0) {
    contentArea = (
      <A2UIRenderer
        ref={rendererRef}
        lines={a2uiLines}
        isStreaming={isStreaming}
        onAction={onAction}
        sessionId={sessionId}
        className="h-full"
      />
    );
  } else {
    contentArea = (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-text-4">{t("canvasCard.empty")}</span>
      </div>
    );
  }

  return (
    <div className="group/canvas my-2 overflow-hidden rounded-lg border border-border-1 bg-bg-2">
      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between border-b border-border-1 bg-fill-2 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Layout size={13} className="shrink-0 text-primary-6" />
          <span className="truncate text-xs font-medium text-text-2">
            {cardTitle}
          </span>
          {isStreaming && <StreamingDot />}
          {mode === "url" && url && (
            <span className="max-w-[160px] truncate text-xs text-text-4">
              {url}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/canvas:opacity-100">
          {handleJumpToSimulator && (
            <IconButton
              onClick={handleJumpToSimulator}
              className="text-text-4 hover:bg-fill-3 hover:text-primary-6"
              title={t("canvasCard.viewInSimulator", "View in Simulator")}
            >
              <Monitor size={12} />
            </IconButton>
          )}
        </div>
      </div>

      {/* ── Content ── */}
      <div
        className="relative w-full overflow-x-auto overflow-y-hidden transition-[height] duration-300 ease-in-out"
        style={{ height: currentHeight }}
      >
        <div className="h-full min-w-full">{contentArea}</div>

        {/* Streaming progress bar — pulsing accent line at bottom edge */}
        {isStreaming && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary-6/40"
            aria-hidden
          />
        )}
      </div>
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
