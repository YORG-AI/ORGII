/**
 * CanvasInlineAdapter — `ChatBlock::CanvasInline` sink.
 *
 * Bridges `render_inline_canvas` tool-call events to `CanvasInlineCard`.
 * The full payload (mode / content / url / title) lives in `props.args`
 * because the Rust broadcast truncates tool_result to 4 000 chars, which
 * would corrupt large HTML payloads. The window-level `canvas-inline-event`
 * stream (used by the simulator overlay) is not consumed here — the chat
 * block reads directly from the normalised event record so each message
 * in chat history renders its own self-contained card.
 *
 * Error handling: when the Rust backend rejects the call (e.g. http://
 * URL in url mode) the event arrives with status="failed". We surface a
 * compact error row rather than a blank card so the user can see what went
 * wrong inline.
 */
import React from "react";

import CanvasInlineCard from "@src/engines/ChatPanel/blocks/CanvasInlineCard";
import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

// ─── helpers ──────────────────────────────────────────────────────────────────

const VALID_MODES = new Set<string>(["html", "url", "a2ui", "react"]);

function isCanvasMode(value: unknown): value is CanvasInlineMode {
  return typeof value === "string" && VALID_MODES.has(value);
}

function extractCanvasArgs(args: Record<string, unknown>): {
  mode: CanvasInlineMode;
  content: string | undefined;
  url: string | undefined;
  title: string | undefined;
} {
  return {
    mode: isCanvasMode(args.mode) ? args.mode : "html",
    content: typeof args.content === "string" ? args.content : undefined,
    url: typeof args.url === "string" ? args.url : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
  };
}

// ─── component ────────────────────────────────────────────────────────────────

export const CanvasInlineAdapter: React.FC<UniversalEventProps> = (props) => {
  const action = deriveToolAction(
    props.functionName ?? props.eventType,
    props.args
  );
  const state = statusToLifecycle(props.status);
  const labels = useLifecycleLabels(props.eventType, action);

  const isRunning = props.status === "running";
  const isFailed = props.status === "failed";

  const { mode, content, url, title } = extractCanvasArgs(props.args);

  // A canvas is considered "streaming" (show waiting indicator) when the
  // agent call is still running AND there is no displayable content yet.
  // showActiveEventPainting is a time-gated heuristic; we extend it here
  // so that any running canvas without content shows "Waiting…" instead of
  // the blank "No content" fallback.
  const hasContent =
    (mode === "url" && Boolean(url)) ||
    ((mode === "html" || mode === "a2ui" || mode === "react") &&
      Boolean(content));

  if (isFailed) {
    const errorText =
      typeof props.result?.error === "string"
        ? props.result.error
        : typeof props.result?.observation === "string"
          ? props.result.observation
          : labels[state] || "Canvas render failed";

    return (
      <div
        data-tool-call-event-id={props.eventId}
        className="my-2 rounded-lg border border-border-1 bg-bg-2 px-3 py-2"
      >
        <p className="text-status-error text-xs">{errorText}</p>
      </div>
    );
  }

  return (
    <div data-tool-call-event-id={props.eventId}>
      <CanvasInlineCard
        mode={mode}
        content={content}
        url={url}
        title={title}
        isStreaming={
          isRunning && (props.showActiveEventPainting === true || !hasContent)
        }
        sessionId={props.sessionId}
      />
    </div>
  );
};

CanvasInlineAdapter.displayName = "CanvasInlineAdapter";

export default CanvasInlineAdapter;
