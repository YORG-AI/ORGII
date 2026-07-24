/**
 * Turn-page formatting helpers.
 *
 * Used by the turn pagination controls to produce preview text for the
 * round label and a HH:MM start/end clock range.
 * Ranges shorter than one minute render as a single HH:MM timestamp.
 */
import type { ExternalReplayTurnSummary } from "@src/api/tauri/externalHistory";
import { PILL_TYPE_LIST } from "@src/config/pillTokens";

import type { ChatGroupMeta } from "../hooks/useChatGroups";

const ROUND_PREVIEW_MAX_LENGTH = 96;
const MIN_TIME_RANGE_MS = 60_000;

/**
 * Strip the bracket portion of pill serialization syntax (`[type:path]`)
 * from text, keeping the display name prefix intact. Produces clean plain
 * text suitable for one-line round preview labels where pill icons cannot
 * be rendered.
 *
 * Only removes the `\s*[type:path]` fragment (not the preceding displayName)
 * so word spacing between adjacent pills is preserved.
 */
const PILL_BRACKET_RE = new RegExp(
  `\\s*\\[(${PILL_TYPE_LIST.join("|")}):([^\\]]+)\\]`,
  "g"
);

function stripPillSyntax(text: string): string {
  return text.replace(PILL_BRACKET_RE, "");
}

export function getRoundPreviewText(displayText: string | undefined): string {
  const stripped = stripPillSyntax(displayText ?? "");
  const normalizedText = stripped.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= ROUND_PREVIEW_MAX_LENGTH) return normalizedText;
  return `${normalizedText.slice(0, ROUND_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function formatReplayTurnPageTimeLabel(
  summary: ExternalReplayTurnSummary
): string {
  const startMs = Date.parse(summary.startedAt);
  const endMs = summary.endedAt ? Date.parse(summary.endedAt) : startMs;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return "";
  return formatClockRange(startMs, endMs);
}

export function formatTurnPageTimeLabel(metas: ChatGroupMeta[]): string {
  let startMs: number | null = null;
  let endMs: number | null = null;

  for (const meta of metas) {
    if (meta.startMs !== null && (startMs === null || meta.startMs < startMs)) {
      startMs = meta.startMs;
    }
    if (meta.endMs !== null && (endMs === null || meta.endMs > endMs)) {
      endMs = meta.endMs;
    }
  }

  if (startMs === null || endMs === null) return "";

  return formatClockRange(startMs, endMs);
}

function formatClockRange(startMs: number, endMs: number): string {
  const startClock = formatClockTime(startMs);
  if (!startClock) return "";
  if (endMs - startMs < MIN_TIME_RANGE_MS) return startClock;

  const endClock = formatClockTime(endMs);
  if (!endClock) return "";

  return `${startClock} ~ ${endClock}`;
}

function formatClockTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "";
  }
}
