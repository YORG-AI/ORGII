import cn from "classnames";
import React from "react";

import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import InlineExpandedSplitCard from "@src/modules/shared/layouts/blocks/InlineExpandedSplitCard";
import InlineInfoCard from "@src/modules/shared/layouts/blocks/InlineInfoCard";

interface InlineCardShellProps {
  children: React.ReactNode;
  gap?: "small" | "default";
}

export function InlineCardShell({
  children,
  gap = "default",
}: InlineCardShellProps) {
  return (
    <InlineInfoCard>
      <div
        className={cn(
          "flex min-w-0 flex-col",
          gap === "small" ? "gap-2" : "gap-3"
        )}
      >
        {children}
      </div>
    </InlineInfoCard>
  );
}

interface InlineCardTabsProps<TabKey extends string> {
  tabs: TabPillItem[];
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
}

export function InlineCardTabs<TabKey extends string>({
  tabs,
  activeTab,
  onChange,
}: InlineCardTabsProps<TabKey>) {
  return (
    <TabPill
      tabs={tabs}
      activeTab={activeTab}
      onChange={(tab) => onChange(tab as TabKey)}
      variant="simple"
      fillWidth={false}
      size="default"
    />
  );
}

interface InlineCardBodyProps {
  children: React.ReactNode;
}

export function InlineCardBody({ children }: InlineCardBodyProps) {
  return <div className="min-w-0 pt-1">{children}</div>;
}

interface InlineCardSectionLabelProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Small uppercase caption used to title sub-sections inside an inline card
 * (e.g. "Install", "Tools", "Dependencies"). Standardises the
 * `text-[11px] uppercase tracking-wide text-text-3` recipe so it can be
 * tweaked in one place.
 */
export function InlineCardSectionLabel({
  children,
  className,
}: InlineCardSectionLabelProps) {
  return (
    <div
      className={cn(
        "text-[11px] font-medium uppercase tracking-wide text-text-3",
        className
      )}
    >
      {children}
    </div>
  );
}

interface InlineCardFooterProps {
  children: React.ReactNode;
}

export function InlineCardFooter({ children }: InlineCardFooterProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-2 pt-3">
      {children}
    </div>
  );
}

interface InlineCardSplitProps {
  left: React.ReactNode;
  right: React.ReactNode;
  equalColumns?: boolean;
  leftClassName?: string;
  rightClassName?: string;
  wrapInCard?: boolean;
}

export function InlineCardSplit({
  left,
  right,
  equalColumns = false,
  leftClassName,
  rightClassName,
  wrapInCard = false,
}: InlineCardSplitProps) {
  return (
    <InlineExpandedSplitCard
      wrapInCard={wrapInCard}
      equalColumns={equalColumns}
      left={left}
      right={right}
      leftClassName={leftClassName}
      rightClassName={rightClassName}
    />
  );
}

interface InlineCardColumnStackProps {
  children: React.ReactNode;
  gap?: "compact" | "default";
}

export function InlineCardColumnStack({
  children,
  gap = "default",
}: InlineCardColumnStackProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col",
        gap === "compact" ? "gap-0.5" : "gap-2"
      )}
    >
      {children}
    </div>
  );
}

interface InlineSplitNavRowProps {
  label: React.ReactNode;
  meta?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function InlineSplitNavRow({
  label,
  meta,
  selected = false,
  disabled = false,
  onSelect,
}: InlineSplitNavRowProps) {
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex h-9 min-h-9 items-center justify-between gap-3 rounded-md px-3 text-xs",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-fill-1",
        selected && "bg-fill-1"
      )}
      onClick={() => {
        if (disabled) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate font-medium leading-none text-text-1">
        {label}
      </span>
      {meta ? (
        <span className="shrink-0 font-normal tabular-nums text-text-2">
          {meta}
        </span>
      ) : null}
    </div>
  );
}
