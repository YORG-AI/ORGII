/**
 * Canvas payload extraction and labelling.
 *
 * Pure helpers that turn a `render_inline_canvas` SessionEvent into the
 * shape the canvas surfaces render, plus the fallbacks used for titles and
 * sidebar timestamps.
 */
import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

export interface CanvasPayload {
  mode: CanvasInlineMode;
  content?: string;
  url?: string;
  title?: string;
  streaming?: boolean;
}

export function extractPayload(event: SessionEvent): CanvasPayload | null {
  const args = event.args as Record<string, unknown> | undefined;
  if (!args) return null;
  const mode = (args.mode as CanvasInlineMode | undefined) ?? "html";
  return {
    mode,
    content: args.content as string | undefined,
    url: args.url as string | undefined,
    title: args.title as string | undefined,
    streaming: args.streaming === true,
  };
}

export function getDefaultTitle(
  payload: CanvasPayload,
  t: (key: string, fallback: string) => string
): string {
  if (payload.title) return payload.title;
  if (payload.mode === "url") return t("canvasCard.titleUrl", "Web Page");
  if (payload.mode === "a2ui") return t("canvasCard.titleA2ui", "Agent UI");
  if (payload.mode === "react")
    return t("canvasCard.titleReact", "React Preview");
  return t("canvasCard.titleHtml", "Agent Preview");
}

export function formatEventTime(event: SessionEvent): string {
  const ts = (event as unknown as { timestamp?: number | string }).timestamp;
  if (!ts) return "";
  try {
    const d = new Date(typeof ts === "number" ? ts : ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
