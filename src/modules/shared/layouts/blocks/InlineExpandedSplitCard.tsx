import React from "react";

import InlineInfoCard from "./InlineInfoCard";

/** Fixed scroll region for table expanded inline split panes (left keys/groups, right variants). */
const INLINE_EXPANDED_SPLIT_SCROLL_MAX_HEIGHT = "max-h-[360px]";

interface InlineExpandedSplitCardProps {
  left: React.ReactNode;
  right: React.ReactNode;
  leftClassName?: string;
  rightClassName?: string;
  /**
   * When true, left/right are treated as symmetric info columns. Below the
   * container-query breakpoint they collapse into a single stacked column so
   * neither side gets squeezed (e.g. when a detail panel is open beside the
   * table). When false, the split keeps its nav-list (left) + content (right)
   * shape at every width — used by KeyVault Accounts/Models/CLI Clients where
   * the left rail is a navigation list that must stay aligned with the right
   * pane.
   */
  equalColumns?: boolean;
  showSeparator?: boolean;
  wrapInCard?: boolean;
}

const InlineExpandedSplitCard: React.FC<InlineExpandedSplitCardProps> = ({
  left,
  right,
  leftClassName,
  rightClassName = "",
  equalColumns = false,
  showSeparator = true,
  wrapInCard = true,
}) => {
  const separatorClassName = showSeparator ? "border-r border-border-2" : "";
  const resolvedLeftClassName =
    leftClassName ?? (equalColumns ? "min-w-0 flex-1" : "w-[min(42%,280px)]");
  const leftPaneClassName = equalColumns
    ? "flex min-h-0 min-w-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain pr-3 scrollbar-hide"
    : "flex min-h-0 shrink-0 flex-col gap-0.5 overflow-y-auto overscroll-contain pr-3 scrollbar-hide";

  // Non-equalColumns variant: keep the original side-by-side layout at every
  // width (nav-list left + content right).
  if (!equalColumns) {
    const sideBySide = (
      <div
        className={`flex min-h-0 min-w-0 gap-4 ${INLINE_EXPANDED_SPLIT_SCROLL_MAX_HEIGHT}`}
      >
        <div
          className={`${leftPaneClassName} ${INLINE_EXPANDED_SPLIT_SCROLL_MAX_HEIGHT} ${separatorClassName} ${resolvedLeftClassName}`}
        >
          {left}
        </div>
        <div
          className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain scrollbar-hide ${INLINE_EXPANDED_SPLIT_SCROLL_MAX_HEIGHT} ${rightClassName}`}
        >
          {right}
        </div>
      </div>
    );

    if (!wrapInCard) return sideBySide;
    return <InlineInfoCard>{sideBySide}</InlineInfoCard>;
  }

  // equalColumns variant: container-query responsive — stacks into one column
  // below 520px so info rows stay readable when the table is narrow. Tailwind
  // arbitrary-value classes are kept inline as literals so the JIT can scan
  // them; do not refactor into runtime string interpolation.
  const responsive = (
    <div className="min-w-0 @container">
      <div className="flex min-h-0 min-w-0 flex-col gap-3 @[520px]:max-h-[360px] @[520px]:flex-row @[520px]:gap-4">
        <div
          className={`flex min-h-0 min-w-0 flex-col gap-0.5 overflow-y-auto overscroll-contain scrollbar-hide @[520px]:max-h-[360px] @[520px]:flex-1 @[520px]:pr-3 ${
            showSeparator ? "@[520px]:border-r @[520px]:border-border-2" : ""
          } ${leftClassName ?? ""}`}
        >
          {left}
        </div>
        <div
          className={`min-h-0 min-w-0 overflow-y-auto overscroll-contain scrollbar-hide @[520px]:max-h-[360px] @[520px]:flex-1 ${rightClassName}`}
        >
          {right}
        </div>
      </div>
    </div>
  );

  if (!wrapInCard) return responsive;
  return <InlineInfoCard>{responsive}</InlineInfoCard>;
};

export default InlineExpandedSplitCard;
