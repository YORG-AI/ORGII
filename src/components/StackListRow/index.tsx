import React from "react";

import { TREE_ROW_HOVER_BG_CLASS } from "@src/components/TreeRow";
import { COMPOSER_STACK_ROW_HOVER } from "@src/config/composerStackTokens";

type StackListRowVariant = "path" | "info";
type StackListRowHoverTone = "tree" | "composer";
type StackListRowLayout = "flex" | "columns";

interface StackListRowProps {
  title?: string;
  leading: React.ReactNode;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
  trailing?: React.ReactNode;
  variant?: StackListRowVariant;
  hoverTone?: StackListRowHoverTone;
  layout?: StackListRowLayout;
  columnsClassName?: string;
  className?: string;
}

function hasSecondaryColumn(secondary: React.ReactNode): boolean {
  if (secondary === undefined || secondary === null || secondary === false) {
    return false;
  }
  if (typeof secondary === "string") {
    return secondary.length > 0;
  }
  return true;
}

function StackListRowComponent({
  title,
  leading,
  primary,
  secondary,
  trailing,
  variant = "path",
  hoverTone = "tree",
  layout = "flex",
  columnsClassName = "grid-cols-[minmax(180px,1.1fr)_minmax(220px,2fr)_120px]",
  className = "",
}: StackListRowProps) {
  const showSecondary = hasSecondaryColumn(secondary);
  const hoverClass =
    hoverTone === "tree" ? TREE_ROW_HOVER_BG_CLASS : COMPOSER_STACK_ROW_HOVER;
  const primaryClass =
    variant === "info"
      ? "min-w-0 truncate text-[13px] font-medium text-text-1"
      : "min-w-0 truncate text-[13px] text-text-2";
  const secondaryClass =
    variant === "info"
      ? "min-w-0 truncate text-right text-[12px] text-text-2"
      : "min-w-0 truncate text-right text-[12px] text-text-3";

  if (layout === "columns") {
    return (
      <div
        title={title}
        className={`group flex h-7 min-w-0 items-center gap-1.5 rounded px-1.5 transition-colors ${hoverClass} ${className}`}
      >
        <div
          className={`grid min-w-0 flex-1 items-center gap-4 ${columnsClassName}`}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {leading}
            <span className={primaryClass}>{primary}</span>
          </div>
          <span className={`${secondaryClass} text-left!`}>
            {showSecondary ? secondary : null}
          </span>
          <span className="min-w-0 truncate text-right text-[12px] text-text-3">
            {trailing}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      title={title}
      className={`group flex h-6 min-w-0 items-center gap-1.5 rounded px-1.5 transition-colors ${hoverClass} ${className}`}
    >
      {leading}
      <span
        className={`${primaryClass} ${showSecondary ? "shrink-0" : "flex-1"}`}
      >
        {primary}
      </span>
      {showSecondary && (
        <span className={`flex-1 ${secondaryClass}`}>{secondary}</span>
      )}
      {trailing && <span className="ml-auto shrink-0">{trailing}</span>}
    </div>
  );
}

export const StackListRow = React.memo(StackListRowComponent);
