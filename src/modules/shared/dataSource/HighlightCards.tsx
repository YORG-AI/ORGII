import { memo } from "react";

import type { Highlight, HighlightKind } from "@src/api/tauri/builderProfile";
import { STAT_GRID_TOKENS } from "@src/config/detailPanelTokens";

/**
 * One fact per card: the question, the answer, and the line that makes the
 * answer mean something.
 *
 * The deck arrives already interleaved by family, so the grid renders it in
 * order — reading down the page alternates between records, rhythm, craft,
 * style and totals rather than marching through five blocks of the same shape.
 * `kind` only tints the question line; the card layout stays identical so the
 * grid reads as one set.
 */
const KIND_TINT: Record<HighlightKind, string> = {
  extreme: "text-primary-6",
  rhythm: "text-success-5",
  craft: "text-warning-5",
  style: "text-text-2",
  scale: "text-text-3",
};

const HighlightCards = memo(function HighlightCards({
  highlights,
}: {
  highlights: Highlight[];
}) {
  if (highlights.length === 0) return null;

  return (
    <div
      className={STAT_GRID_TOKENS.cols3}
      data-testid="builder-profile-highlights"
    >
      {highlights.map((card) => (
        <div
          key={card.id}
          className="flex flex-col gap-1 rounded-lg bg-bg-2 px-3 py-3"
          data-testid={`highlight-${card.id}`}
        >
          <span className={`text-xs ${KIND_TINT[card.kind] ?? "text-text-3"}`}>
            {card.question}
          </span>
          <span className="text-lg font-semibold leading-tight text-text-1">
            {card.headline}
          </span>
          <span className="text-xs leading-snug text-text-3">
            {card.detail}
          </span>
        </div>
      ))}
    </div>
  );
});

export default HighlightCards;
