/**
 * DiffView — line-level comparison of two canvas revisions.
 *
 * Rendered by the canvas app's "compare" tab once exactly two sidebar items
 * are marked. Uses the local diffLines utility; oversized inputs bail out
 * with an explanatory placeholder instead of diffing.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";

import { diffLines, isCanvasDiffInputTooLarge } from "./canvasDiff";
import type { CanvasPayload } from "./canvasPayload";

interface DiffViewProps {
  olderPayload: CanvasPayload;
  newerPayload: CanvasPayload;
  olderTitle: string;
  newerTitle: string;
}

const DiffView: React.FC<DiffViewProps> = ({
  olderPayload,
  newerPayload,
  olderTitle,
  newerTitle,
}) => {
  const { t } = useTranslation("sessions");
  const oldText =
    olderPayload.mode === "url"
      ? (olderPayload.url ?? "")
      : (olderPayload.content ?? "");
  const newText =
    newerPayload.mode === "url"
      ? (newerPayload.url ?? "")
      : (newerPayload.content ?? "");
  const tooLarge = isCanvasDiffInputTooLarge(oldText, newText);
  const diff = useMemo(
    () => (tooLarge ? [] : diffLines(oldText, newText)),
    [tooLarge, oldText, newText]
  );

  const addedCount = diff.filter((l) => l.kind === "added").length;
  const removedCount = diff.filter((l) => l.kind === "removed").length;

  if (tooLarge) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <span className="text-xs text-text-4">
          {t(
            "canvasApp.compareTooLarge",
            "These versions are too large to compare"
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* diff header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-1 bg-fill-2 px-3 py-1.5 text-xs">
        <span className="truncate text-text-2">{olderTitle}</span>
        <span className="shrink-0 text-text-4">→</span>
        <span className="truncate text-text-2">{newerTitle}</span>
        <DiffStatsBadge
          additions={addedCount}
          deletions={removedCount}
          variant="plain"
          size="sm"
          className="ml-auto"
        />
      </div>
      {/* diff lines */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <pre className="min-w-0 p-3 font-mono text-[11px] leading-5">
          {diff.map((line, i) => (
            <div
              key={i}
              className={[
                "px-2 break-all whitespace-pre-wrap",
                line.kind === "added"
                  ? "bg-success-6/10 text-success-6"
                  : line.kind === "removed"
                    ? "bg-danger-6/10 text-danger-6"
                    : "text-text-3",
              ].join(" ")}
            >
              <span className="mr-2 text-text-4/50 select-none">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "-"
                    : " "}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
};

DiffView.displayName = "DiffView";
export default DiffView;
