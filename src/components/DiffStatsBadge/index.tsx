import { type ReactNode, memo } from "react";

import { DIFF_STATS } from "@src/config/workstation/tokens";

import {
  type DiffStatsBadgeSize,
  getDiffStatsSizeClass,
} from "./diffStatsBadgeHelpers";

type DiffStatsBadgeVariant = "default" | "compact" | "chat" | "plain";

export interface DiffStatsBadgeProps {
  additions?: number;
  deletions?: number;
  variant?: DiffStatsBadgeVariant;
  /**
   * Intrinsic font-size for the badge. Defaults to `"inherit"` (no font-size
   * class), preserving each variant's baked-in size and any inherited sizing.
   * Use `"xs"` (11px) / `"sm"` (12px) / `"md"` (13px) on `plain` badges instead
   * of re-specifying `text-[Npx]` externally.
   */
  size?: DiffStatsBadgeSize;
  /**
   * Gap utility between the additions and deletions values. Defaults to
   * `"gap-1"`. Pass `"gap-0"` (or another gap token) to override — supplied
   * here rather than via `className` so it can't collide with the baked-in
   * container gap and lose to Tailwind source-order.
   */
  gapClassName?: string;
  /** Reserve a 3ch column for each value so additions/deletions align. */
  reserveValueWidth?: boolean;
  className?: string;
  valueClassName?: string;
  formatValue?: (value: number) => ReactNode;
  showAdditions?: boolean;
  showDeletions?: boolean;
}

const CONTAINER_CLASSES: Record<DiffStatsBadgeVariant, string> = {
  default: `${DIFF_STATS.container} font-mono font-medium leading-none tabular-nums`,
  compact: `${DIFF_STATS.containerCompact} font-mono font-medium leading-none tabular-nums`,
  chat: "chat-block-xs flex shrink-0 items-center font-mono font-medium leading-none tabular-nums",
  plain:
    "inline-flex shrink-0 items-center font-mono font-medium leading-none tabular-nums",
};

const VALUE_BASE_CLASSES = "inline-flex";
const VALUE_ALIGNED_CLASSES = "min-w-[3ch] justify-end";

function joinClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const DiffStatsBadge = memo(function DiffStatsBadge({
  additions = 0,
  deletions = 0,
  variant = "default",
  size = "inherit",
  gapClassName = "gap-1",
  reserveValueWidth = true,
  className,
  valueClassName,
  formatValue = String,
  showAdditions = true,
  showDeletions = true,
}: DiffStatsBadgeProps) {
  const hasAdditions = showAdditions && additions > 0;
  const hasDeletions = showDeletions && deletions > 0;

  if (!hasAdditions && !hasDeletions) {
    return null;
  }

  return (
    <span
      className={joinClasses(
        CONTAINER_CLASSES[variant],
        gapClassName,
        getDiffStatsSizeClass(size),
        className
      )}
    >
      {hasAdditions && (
        <span
          className={joinClasses(
            VALUE_BASE_CLASSES,
            reserveValueWidth ? VALUE_ALIGNED_CLASSES : undefined,
            DIFF_STATS.additions,
            valueClassName
          )}
        >
          +{formatValue(additions)}
        </span>
      )}
      {hasDeletions && (
        <span
          className={joinClasses(
            VALUE_BASE_CLASSES,
            reserveValueWidth ? VALUE_ALIGNED_CLASSES : undefined,
            DIFF_STATS.deletions,
            valueClassName
          )}
        >
          -{formatValue(deletions)}
        </span>
      )}
    </span>
  );
});

export default DiffStatsBadge;
