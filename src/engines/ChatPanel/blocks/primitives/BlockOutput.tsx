/**
 * BlockOutput — shared output rendering primitive for chat blocks.
 *
 * Behaviour:
 * - Long lines do NOT wrap; they scroll horizontally within the block,
 *   matching real-terminal behaviour.
 * - Vertical height is bounded by fixed pixel caps (collapsed ≈ 120px,
 *   expanded ≤ min(320px, 30vh)). Whenever the natural content height
 *   exceeds the collapsed cap, a "Show more" / "Show less" toggle is
 *   rendered.
 * - Optional Shiki syntax highlighting (e.g. lang="log" for terminal
 *   output).
 *
 * Used by TerminalBlock, ToolCallBlock, and any block that displays
 * text-shaped tool output.
 */
import Ansi from "ansi-to-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { externalReplayReadPayloadRange } from "@src/api/tauri/externalHistory/replay";
import { ReplayRequestGuard } from "@src/api/tauri/externalHistory/replayRequestGuard";
import Button from "@src/components/Button";
import ExpandOverlay from "@src/components/ExpandOverlay";
import {
  hasTuiSequences,
  processAnsiContent,
  stripAnsiCodes,
} from "@src/components/TerminalDisplay/utils/ansiProcessor";
import XtermOutput from "@src/components/XtermOutput";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { PayloadRef } from "@src/engines/SessionCore/core/types";
import {
  getLoadedPayload,
  getPayloadRegistryKey,
  getPendingPayloadLoad,
  trackPendingPayloadLoad,
  unloadPayload,
} from "@src/engines/SessionCore/payloads";
import { useShikiHighlight } from "@src/hooks/code";

import "./_block-output.scss";
import {
  EVENT_BLOCK_BORDER_CLASSES,
  EVENT_BLOCK_CONTENT_BG,
  EVENT_BLOCK_FADE_FROM,
  EVENT_SNIPPET_INNER_PADDING_CLASS,
} from "./config";

/**
 * Height policy — measured in pixels, not lines.
 *
 * A real terminal renders one logical line per row and horizontally
 * scrolls long lines; we follow the same model here. Wrapping a single
 * 400-char output line into 30 visual rows in the chat pane (the previous
 * `whitespace-pre-wrap` behaviour) caused terminal blocks to balloon far
 * past the diff block's footprint even though they only carried a
 * handful of logical lines.
 *
 * Collapsed height matches the diff block's 5-line collapsed footprint
 * (≈ 120px). Expanded height is capped at the same `min(320px, 30vh)` as
 * before; the user scrolls vertically within the block instead of pushing
 * subsequent chat items off-screen.
 */
const COLLAPSED_MAX_HEIGHT = 120;
const EXPANDED_MAX_HEIGHT_CSS = "min(320px, 30vh)";
const HIGHLIGHT_MAX_CHARS = 200_000;
const RENDER_FULL_PAYLOAD_MAX_CHARS = 500_000;
const EXTERNAL_PAYLOAD_RANGE_BYTES = 256 * 1024;

interface ExternalPayloadRangePage {
  offset: number;
  nextOffset: number;
  eof: boolean;
  totalBytes: number;
  text: string;
}

export type BlockOutputStatus = "default" | "error" | "success";

export interface BlockOutputProps {
  /** Raw output text */
  output: string;
  /**
   * @deprecated Height is now controlled by pixel caps
   * (`COLLAPSED_MAX_HEIGHT` / `EXPANDED_MAX_HEIGHT_CSS`), not by line
   * count. Prop kept for callsite compatibility; ignored internally.
   */
  visibleLines?: number;
  /** Apply error text styling to output content */
  isError?: boolean;
  /** Status for expand toggle styling (tool calls: error/success) */
  status?: BlockOutputStatus;
  /** Optional custom line renderer (e.g. for highlighting refs in browser snapshots) */
  renderLine?: (line: string, idx: number) => React.ReactNode;
  /** Shiki language for syntax highlighting (e.g. "log"). When set, output
   *  is highlighted with Shiki instead of ANSI. */
  highlightLang?: string;
  /** Shiki theme — defaults to "one-dark-pro" */
  shikiTheme?: string;
  /** Draw an event-block border around this output region. Disable when parent shell already owns the border. */
  withBorder?: boolean;
  sessionId?: string;
  eventId?: string;
  payloadRef?: PayloadRef;
  onFullPayloadLoaded?: (body: string) => void;
  collapsedMaxHeight?: number;
  defaultScrollToBottom?: boolean;
  expandLineThreshold?: number;
  /**
   * Force xterm.js TUI rendering regardless of auto-detection.
   * Auto-detects by default when the output contains VT100 cursor/erase
   * sequences (spinners, progress bars, box-drawing TUI output).
   */
  tuiRendering?: boolean;
}

/**
 * Shared output section for chat blocks.
 *
 * Long lines DO NOT wrap (`whitespace-pre`); they scroll horizontally
 * inside the block, matching real-terminal behaviour. Height is bounded
 * by pixel caps in both collapsed and expanded states so a single line
 * with hundreds of chars cannot blow up the block.
 */
const BlockOutput: React.FC<BlockOutputProps> = memo(
  ({
    output,
    isError = false,
    status: _status = "default",
    renderLine,
    highlightLang,
    shikiTheme = "one-dark-pro",
    withBorder = true,
    sessionId,
    eventId,
    payloadRef,
    onFullPayloadLoaded,
    collapsedMaxHeight = COLLAPSED_MAX_HEIGHT,
    defaultScrollToBottom = false,
    expandLineThreshold,
    tuiRendering,
  }) => {
    const { t } = useTranslation();
    const [isOutputExpanded, setIsOutputExpanded] = useState(false);
    const [fullPayload, setFullPayload] = useState<string | null>(null);
    const [externalPayloadRange, setExternalPayloadRange] =
      useState<ExternalPayloadRangePage | null>(null);
    const [payloadLoadError, setPayloadLoadError] = useState<string | null>(
      null
    );
    const [isLoadingPayload, setIsLoadingPayload] = useState(false);
    const replayPayloadRequestGuard = useRef(new ReplayRequestGuard());

    const payloadKey =
      payloadRef && sessionId && eventId
        ? getPayloadRegistryKey(sessionId, eventId, payloadRef.fieldPath)
        : null;

    useEffect(() => {
      const requestGuard = replayPayloadRequestGuard.current;
      requestGuard.invalidate();
      setIsLoadingPayload(false);
      if (!payloadKey) {
        setFullPayload(null);
        setExternalPayloadRange(null);
        return;
      }
      setFullPayload(getLoadedPayload(payloadKey));
      setExternalPayloadRange(null);
      setPayloadLoadError(null);
      return () => requestGuard.invalidate();
    }, [payloadKey, payloadRef?.replayGeneration]);

    const isExternalReplayPayload = Boolean(
      payloadRef?.replayGeneration && payloadRef.replaySourceEventId
    );

    const shouldRenderFullPayload =
      fullPayload !== null &&
      fullPayload.length <= RENDER_FULL_PAYLOAD_MAX_CHARS;
    const displayOutput = externalPayloadRange
      ? externalPayloadRange.text
      : shouldRenderFullPayload
        ? fullPayload
        : output;

    const useTuiRenderer = useMemo(
      () => tuiRendering ?? hasTuiSequences(displayOutput),
      [tuiRendering, displayOutput]
    );

    const processedOutput = useMemo(
      () =>
        useTuiRenderer ? displayOutput : processAnsiContent(displayOutput),
      [useTuiRenderer, displayOutput]
    );
    const outputLines = useMemo(
      () => processedOutput.split("\n"),
      [processedOutput]
    );

    // Shiki-highlighted HTML for the full output
    const plainText = useMemo(
      () => (highlightLang ? stripAnsiCodes(processedOutput) : ""),
      [highlightLang, processedOutput]
    );
    const canHighlight =
      Boolean(highlightLang) &&
      plainText.length > 0 &&
      plainText.length <= HIGHLIGHT_MAX_CHARS;
    const highlightedHtml = useShikiHighlight(plainText, {
      lang: highlightLang,
      theme: shikiTheme,
      enabled: canHighlight,
    });

    // The viewport is always clamped to `collapsedMaxHeight`; we then ask
    // the viewport itself whether its scrollHeight exceeds clientHeight to
    // decide whether the fade + "Show more" pill should be shown. Doing the
    // measurement against the always-clamped viewport (rather than a
    // separate content wrapper whose layout depends on async Shiki and
    // ResizeObserver wakeups) keeps `needsExpand` correct the moment the
    // browser settles — regardless of highlight timing or fast-refresh
    // remounts.
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);
    const [needsExpand, setNeedsExpand] = useState(false);
    const [scrollTop, setScrollTop] = useState(0);
    useLayoutEffect(() => {
      const el = viewportRef.current;
      if (!el) return;
      const measure = () => {
        const hasVerticalOverflow = el.scrollHeight > el.clientHeight + 1;
        const exceedsLineThreshold =
          expandLineThreshold !== undefined &&
          outputLines.length > expandLineThreshold;
        setNeedsExpand(hasVerticalOverflow || exceedsLineThreshold);
      };
      measure();
      const handleScroll = () => {
        setScrollTop(el.scrollTop);
        measure();
      };
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      const contentEl = contentRef.current;
      if (contentEl) observer.observe(contentEl);
      el.addEventListener("scroll", handleScroll, { passive: true });
      return () => {
        observer.disconnect();
        el.removeEventListener("scroll", handleScroll);
      };
    }, [
      processedOutput,
      highlightedHtml,
      isOutputExpanded,
      defaultScrollToBottom,
      expandLineThreshold,
      outputLines.length,
    ]);

    useLayoutEffect(() => {
      if (!defaultScrollToBottom) return;
      const el = viewportRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
      setNeedsExpand(el.scrollHeight > el.clientHeight + 1);
    }, [
      defaultScrollToBottom,
      processedOutput,
      highlightedHtml,
      isOutputExpanded,
    ]);

    const canLoadFullPayload = Boolean(
      payloadRef &&
      sessionId &&
      eventId &&
      (isExternalReplayPayload
        ? externalPayloadRange === null
        : fullPayload === null)
    );
    const loadExternalPayloadRange = useCallback(
      async (offset: number) => {
        if (
          !payloadRef?.replayGeneration ||
          !payloadRef.replaySourceEventId ||
          !sessionId
        ) {
          return;
        }
        const requestEpoch = replayPayloadRequestGuard.current.begin();
        setIsLoadingPayload(true);
        setPayloadLoadError(null);
        try {
          const range = await externalReplayReadPayloadRange({
            sessionId,
            generation: payloadRef.replayGeneration,
            eventId: payloadRef.replaySourceEventId,
            fieldPath: payloadRef.fieldPath,
            offset,
            maxBytes: EXTERNAL_PAYLOAD_RANGE_BYTES,
          });
          if (!replayPayloadRequestGuard.current.isCurrent(requestEpoch))
            return;
          setExternalPayloadRange(range);
          setIsOutputExpanded(true);
        } catch (error) {
          if (!replayPayloadRequestGuard.current.isCurrent(requestEpoch))
            return;
          setPayloadLoadError(
            error instanceof Error ? error.message : String(error)
          );
        } finally {
          if (replayPayloadRequestGuard.current.isCurrent(requestEpoch)) {
            setIsLoadingPayload(false);
          }
        }
      },
      [payloadRef, sessionId]
    );
    const handleLoadFullPayload = useCallback(async () => {
      if (!payloadRef || !sessionId || !eventId || !payloadKey) return;
      if (isExternalReplayPayload) {
        await loadExternalPayloadRange(0);
        return;
      }
      const loaded = getLoadedPayload(payloadKey);
      if (loaded !== null) {
        setFullPayload(loaded);
        onFullPayloadLoaded?.(loaded);
        setIsOutputExpanded(true);
        return;
      }
      setIsLoadingPayload(true);
      try {
        const pending = getPendingPayloadLoad(payloadKey);
        const body = pending
          ? await pending
          : await trackPendingPayloadLoad(
              payloadKey,
              eventStoreProxy
                .loadEventPayload(sessionId, eventId, payloadRef.fieldPath)
                .then((payload) => payload?.body ?? null)
            );
        if (body !== null) {
          setFullPayload(body);
          onFullPayloadLoaded?.(body);
          setIsOutputExpanded(true);
        }
      } finally {
        setIsLoadingPayload(false);
      }
    }, [
      eventId,
      isExternalReplayPayload,
      loadExternalPayloadRange,
      onFullPayloadLoaded,
      payloadKey,
      payloadRef,
      sessionId,
    ]);

    const preClassesShared = `block-output__pre m-0 whitespace-pre ${EVENT_SNIPPET_INNER_PADDING_CLASS} leading-normal`;
    const useTopCollapsedOverlay = defaultScrollToBottom && !isOutputExpanded;
    const showExpandOverlay = needsExpand || isOutputExpanded;

    const expandOverlay = showExpandOverlay ? (
      <ExpandOverlay
        isExpanded={isOutputExpanded}
        onToggle={() => {
          if (isOutputExpanded) {
            viewportRef.current?.scrollTo({ top: 0 });
          }
          setIsOutputExpanded(!isOutputExpanded);
        }}
        collapsedLabel={t("common:showMore")}
        collapsedFadeEdge={useTopCollapsedOverlay ? "top" : "bottom"}
        collapsedOffsetPx={useTopCollapsedOverlay ? scrollTop : 0}
        fadeFrom={EVENT_BLOCK_FADE_FROM}
      />
    ) : null;

    return (
      <div
        ref={viewportRef}
        className={`group/expand relative scrollbar-hide ${withBorder ? EVENT_BLOCK_BORDER_CLASSES : ""} ${EVENT_BLOCK_CONTENT_BG}`}
        style={
          isOutputExpanded
            ? {
                maxHeight: EXPANDED_MAX_HEIGHT_CSS,
                overflowY: "auto",
                overflowX: "auto",
              }
            : {
                maxHeight: collapsedMaxHeight,
                overflowY: "hidden",
                overflowX: "auto",
              }
        }
      >
        {useTopCollapsedOverlay ? expandOverlay : null}
        <div ref={contentRef}>
          {useTuiRenderer ? (
            <XtermOutput
              content={processedOutput}
              className={EVENT_SNIPPET_INNER_PADDING_CLASS}
            />
          ) : highlightLang && highlightedHtml ? (
            <div
              className={`${preClassesShared} [&_pre.shiki]:!m-0 [&_pre.shiki]:!bg-transparent [&_pre.shiki]:!p-0 [&_pre.shiki]:!shadow-none`}
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre
              className={`${preClassesShared} ${
                isError ? "text-danger-6" : "text-text-2"
              }`}
            >
              {outputLines.map((line, idx) => (
                <div
                  key={idx}
                  className="block-output__line min-h-4 leading-normal"
                >
                  {renderLine ? renderLine(line, idx) : <Ansi>{line}</Ansi>}
                </div>
              ))}
            </pre>
          )}
        </div>

        {externalPayloadRange && payloadRef ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-2 bg-fill-1/60 px-3 py-2 text-xs text-text-3">
            <span>
              {externalPayloadRange.offset.toLocaleString()}–
              {externalPayloadRange.nextOffset.toLocaleString()} /{" "}
              {externalPayloadRange.totalBytes.toLocaleString()} bytes
            </span>
            <div className="flex gap-2">
              <Button
                size="mini"
                variant="tertiary"
                appearance="outline"
                disabled={isLoadingPayload || externalPayloadRange.offset === 0}
                onClick={() =>
                  void loadExternalPayloadRange(
                    Math.max(
                      0,
                      externalPayloadRange.offset - EXTERNAL_PAYLOAD_RANGE_BYTES
                    )
                  )
                }
              >
                {t("common:actions.previous", { defaultValue: "Previous" })}
              </Button>
              <Button
                size="mini"
                variant="tertiary"
                appearance="outline"
                disabled={isLoadingPayload || externalPayloadRange.eof}
                onClick={() =>
                  void loadExternalPayloadRange(externalPayloadRange.nextOffset)
                }
              >
                {t("common:actions.next", { defaultValue: "Next" })}
              </Button>
              <Button
                size="mini"
                variant="tertiary"
                appearance="outline"
                onClick={() => {
                  setExternalPayloadRange(null);
                  setIsOutputExpanded(false);
                }}
              >
                {t("common:showLess")}
              </Button>
            </div>
          </div>
        ) : null}

        {!isExternalReplayPayload && fullPayload !== null && payloadKey && (
          <div className="flex items-center justify-between border-t border-border-2 bg-fill-1/60 px-3 py-2 text-xs text-text-3">
            <span>
              {fullPayload.length.toLocaleString()} bytes loaded
              {!shouldRenderFullPayload
                ? " · preview retained for rendering"
                : ""}
            </span>
            <button
              type="button"
              className="rounded-md border border-border-2 px-2 py-1 text-text-2 hover:bg-fill-2"
              onClick={() => {
                unloadPayload(payloadKey);
                setFullPayload(null);
                setIsOutputExpanded(false);
              }}
            >
              {t("common:showLess")}
            </button>
          </div>
        )}

        {canLoadFullPayload && (
          <div className="flex items-center justify-between border-t border-border-2 bg-fill-1/60 px-3 py-2 text-xs text-text-3">
            <span>
              {payloadRef?.fullSizeBytes.toLocaleString()} bytes previewed
            </span>
            <button
              type="button"
              className="rounded-md border border-border-2 px-2 py-1 text-text-2 hover:bg-fill-2 disabled:opacity-60"
              disabled={isLoadingPayload}
              onClick={handleLoadFullPayload}
            >
              {isLoadingPayload
                ? t("common:status.loading")
                : t("common:showMore")}
            </button>
          </div>
        )}

        {payloadLoadError ? (
          <div
            role="alert"
            className="border-t border-border-2 px-3 py-2 text-xs text-danger-6"
          >
            {payloadLoadError}
          </div>
        ) : null}

        {!useTopCollapsedOverlay ? expandOverlay : null}
      </div>
    );
  }
);

BlockOutput.displayName = "BlockOutput";

export default BlockOutput;
