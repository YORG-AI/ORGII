/**
 * ContextCategoryRow
 *
 * A single row in the context-info panel's category breakdown list.
 * Highlights on hover and syncs the hover state with the BreakdownBar
 * via callbacks.
 */
import { memo } from "react";

import { formatTokenCount } from "./useContextUsageInfo";

export interface ContextCategoryRowProps {
  label: string;
  tokens: number;
  percent: number;
  hex: string;
  categoryKey?: string;
  isHovered: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const ContextCategoryRow = memo(
  ({
    label,
    tokens,
    percent,
    hex,
    categoryKey,
    isHovered,
    onMouseEnter,
    onMouseLeave,
  }: ContextCategoryRowProps) => (
    <div
      data-testid={
        categoryKey ? `context-info-category-${categoryKey}` : undefined
      }
      className="cursor-default rounded-md px-1 py-[3px]"
      style={{
        backgroundColor: isHovered ? "rgba(128,128,128,0.08)" : undefined,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="h-[9px] w-[9px] shrink-0 rounded-[3px]"
          style={{ backgroundColor: hex }}
        />
        <span className="flex-1 truncate text-[12px] text-text-1">{label}</span>
        <span className="shrink-0 text-[11px] text-text-3 tabular-nums">
          {percent}%
        </span>
        <span className="shrink-0 text-[12px] text-text-2 tabular-nums">
          {formatTokenCount(tokens)}
        </span>
      </div>
    </div>
  )
);

ContextCategoryRow.displayName = "ContextCategoryRow";

export default ContextCategoryRow;
