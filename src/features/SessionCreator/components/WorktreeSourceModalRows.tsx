import { Check, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import {
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH,
} from "@src/components/Dropdown/tokens";

const SOURCE_LIST_CLASS = `min-h-0 flex-1 ${DROPDOWN_PANEL.optionsMaxHeightClass} overflow-y-auto rounded-lg border border-border-2 bg-bg-2 p-1`;

export function WorktreeSourceList({ children }: { children: ReactNode }) {
  return <div className={SOURCE_LIST_CLASS}>{children}</div>;
}

export function WorktreeSourceRefreshSuffix({
  disabled,
  refreshing,
  ariaLabel,
  onClick,
}: {
  disabled?: boolean;
  refreshing?: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex shrink-0 items-center justify-center border-none bg-transparent p-0 text-text-3 transition-colors hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <RefreshCw
        size={DROPDOWN_SEARCH.iconSize}
        strokeWidth={1.75}
        className={refreshing ? "animate-spin" : undefined}
      />
    </button>
  );
}

export function WorktreeSourceRow({
  icon,
  title,
  detail,
  meta,
  selected,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  meta?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center py-1 text-left ${DROPDOWN_ITEM.minHeightClass} ${DROPDOWN_ITEM.gapClass} ${DROPDOWN_ITEM.paddingXClass} ${DROPDOWN_ITEM.borderRadiusClass} ${DROPDOWN_ITEM.transitionClass} ${
        selected
          ? "bg-surface-hover text-text-1"
          : "text-text-2 hover:bg-surface-hover hover:text-text-1"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5 text-text-1">
          {title}
        </span>
        {detail && (
          <span className="block truncate text-[12px] leading-4 text-text-3">
            {detail}
          </span>
        )}
      </span>
      {meta && (
        <span className="shrink-0 text-[12px] tabular-nums leading-4 text-text-3">
          {meta}
        </span>
      )}
      {selected && (
        <Check
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary-6"
        />
      )}
    </button>
  );
}
