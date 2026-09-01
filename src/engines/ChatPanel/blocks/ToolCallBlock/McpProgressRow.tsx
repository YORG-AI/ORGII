/**
 * McpProgressRow.
 *
 * Inline progress indicator rendered inside an MCP tool chat bubble
 * while the remote server streams `notifications/progress` ticks.
 *
 * Rendering rules:
 *  - `total === null` (server did not advertise a bound) → indeterminate
 *    spinner with just the numeric progress + optional label.
 *  - `total` is a finite number > 0 → progress bar (progress / total
 *    clamped to [0, 1]); shows "42 / 100" + optional label.
 *
 * The row unmounts itself when `mcpProgressMapAtom` no longer has an
 * entry for the `(sessionId, toolCallId)` pair — that is driven by
 * `handleToolResult` clearing the entry the moment the final tool_result
 * event lands.
 */
import { useAtomValue } from "jotai";
import React from "react";

import {
  getMcpProgress,
  mcpProgressMapAtom,
} from "@src/store/session/mcpProgressAtom";

export interface McpProgressRowProps {
  sessionId: string;
  toolCallId: string;
}

function formatPercentage(progress: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "";
  const ratio = Math.max(0, Math.min(1, progress / total));
  return `${Math.round(ratio * 100)}%`;
}

const McpProgressRow: React.FC<McpProgressRowProps> = ({
  sessionId,
  toolCallId,
}) => {
  const progressMap = useAtomValue(mcpProgressMapAtom);
  const entry = getMcpProgress(progressMap, sessionId, toolCallId);

  if (!entry) return null;

  const hasBoundedTotal =
    typeof entry.total === "number" &&
    Number.isFinite(entry.total) &&
    entry.total > 0;

  const ratio = hasBoundedTotal
    ? Math.max(0, Math.min(1, entry.progress / (entry.total as number)))
    : null;

  const percentLabel = hasBoundedTotal
    ? formatPercentage(entry.progress, entry.total as number)
    : "";

  const numericLabel = hasBoundedTotal
    ? `${entry.progress} / ${entry.total}`
    : `${entry.progress}`;

  return (
    <div
      className="flex flex-col gap-1 px-3 py-2 text-xs text-text-3"
      data-mcp-progress={toolCallId}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {hasBoundedTotal ? (
            <span className="shrink-0 font-medium text-text-2">
              {percentLabel}
            </span>
          ) : (
            <span
              className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary-6"
              aria-hidden="true"
            />
          )}
          {entry.message ? (
            <span className="truncate" title={entry.message}>
              {entry.message}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 tabular-nums">{numericLabel}</span>
      </div>
      {hasBoundedTotal && ratio !== null ? (
        <div className="relative h-1 w-full overflow-hidden rounded-full bg-fill-2">
          <div
            className="absolute top-0 left-0 h-full rounded-full bg-primary-6 transition-[width] duration-150 ease-out"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
};

McpProgressRow.displayName = "McpProgressRow";

export default McpProgressRow;
