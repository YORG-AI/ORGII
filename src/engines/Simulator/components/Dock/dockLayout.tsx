/**
 * Station dock layout primitives — glass pill, icon columns, segment divider, row wrapper.
 * Consumed by Dock and DockReplayControl; kept out of index.ts to avoid circular imports
 * (those components cannot import from the barrel that re-exports them).
 */
import React, { memo } from "react";

import { classNames } from "@src/util/ui/classNames";

import { AGENT_DOT_TOKENS } from "../../config";

/**
 * Spacer-mode column height: 36px hit + 1px gap + 4px trailer row (matches DockIconColumn).
 * Divider uses this box height + top padding so the rule’s center lines up with the icon center (18px).
 */
export const DOCK_COLUMN_HEIGHT_SPACER_PX = 41;

/** Vertical rule; padding top keeps line center at 18px (36px icon mid). */
const DOCK_SEGMENT_LINE_HEIGHT_PX = 24;
const DOCK_SEGMENT_DIVIDER_PADDING_TOP_PX =
  18 - DOCK_SEGMENT_LINE_HEIGHT_PX / 2;

const DOCK_SEGMENT_LINE_CLASS = "w-px shrink-0 bg-border-2";

/** Passed to glyph icons inside dock slots */
export const DOCK_ICON_PROPS = {
  size: 20,
  strokeWidth: 1.75,
} as const;

export function dockIconHitAreaClassName(options: {
  active?: boolean;
  /** Unpinned / overflow slot — fill-3 (selected app uses primary-6 via active) */
  forcePrimary?: boolean;
}): string {
  const isActive = options.active ?? false;
  const forcePrimary = options.forcePrimary ?? false;
  const tone = isActive
    ? "text-primary-6"
    : forcePrimary
      ? "text-fill-3 hover:text-text-2"
      : "text-text-1 hover:text-text-2";
  return `relative flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-xl transition-colors duration-200 ${tone}`;
}

export type DockIconTrailerMode =
  | "spacer"
  | "agent-working"
  | "overflow-marker";

/** Nudge Agent focus dots slightly closer to the icon; layout box unchanged (transform only). */
const DOCK_TRAILER_DOT_NUDGE_UP_CLASS = "translate-y-[-2.5px]";

export const DockSegmentDivider: React.FC = memo(() => (
  <div
    className="mx-1 flex shrink-0 flex-col items-center justify-start"
    style={{
      height: DOCK_COLUMN_HEIGHT_SPACER_PX,
      paddingTop: DOCK_SEGMENT_DIVIDER_PADDING_TOP_PX,
    }}
    aria-hidden
  >
    <div
      className={DOCK_SEGMENT_LINE_CLASS}
      style={{ height: DOCK_SEGMENT_LINE_HEIGHT_PX }}
    />
  </div>
));

DockSegmentDivider.displayName = "DockSegmentDivider";

export interface StationDockGlassPillProps {
  children: React.ReactNode;
}

export const StationDockGlassPill: React.FC<StationDockGlassPillProps> = memo(
  ({ children }) => (
    <div className="relative flex h-12 flex-row items-center gap-1 overflow-visible px-1.5 py-0">
      {children}
    </div>
  )
);

StationDockGlassPill.displayName = "StationDockGlassPill";

export interface StationDockRowProps {
  /** Centered under chrome (My Station); left + room for trailing (Agent) */
  layout: "centered" | "withTrailingSlot";
  children: React.ReactNode;
  /** Rendered immediately to the right of the glass pill (e.g. keyboard) */
  trailing?: React.ReactNode;
}

export const StationDockRow: React.FC<StationDockRowProps> = memo(
  ({ children, trailing }) => (
    <div className="relative flex w-full max-w-full min-w-0 items-center justify-center gap-2">
      {children}
      {trailing ?? null}
    </div>
  )
);

StationDockRow.displayName = "StationDockRow";

export interface DockIconColumnProps {
  children: React.ReactNode;
  trailer: DockIconTrailerMode;
}

export interface CompactDockIconColumnProps {
  children: React.ReactNode;
}

/**
 * One dock app slot: 36×36 icon area + fixed trailer row so total height matches Agent dock.
 */
export const DockIconColumn: React.FC<DockIconColumnProps> = memo(
  ({ children, trailer }) => {
    const bottomContent =
      trailer === "agent-working" ? (
        <div className={AGENT_DOT_TOKENS.dotSmall} />
      ) : trailer === "overflow-marker" ? (
        <div className={AGENT_DOT_TOKENS.dot} />
      ) : (
        <div className="h-[4px] w-[4px]" aria-hidden />
      );

    const bottomWrapperClass = classNames(
      trailer === "overflow-marker"
        ? "flex h-[6px] w-[6px] items-center justify-center"
        : AGENT_DOT_TOKENS.containerSmall,
      trailer !== "spacer" && DOCK_TRAILER_DOT_NUDGE_UP_CLASS
    );

    return (
      <div className="group relative flex flex-col items-center gap-px overflow-visible">
        {children}
        <div className={bottomWrapperClass}>{bottomContent}</div>
      </div>
    );
  }
);

DockIconColumn.displayName = "DockIconColumn";

export const CompactDockIconColumn: React.FC<CompactDockIconColumnProps> = memo(
  ({ children }) => (
    <div className="group relative flex h-[36px] items-center justify-center overflow-visible">
      {children}
    </div>
  )
);

CompactDockIconColumn.displayName = "CompactDockIconColumn";
