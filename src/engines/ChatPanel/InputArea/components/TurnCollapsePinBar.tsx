/**
 * TurnCollapsePinBar — "Agent worked for xxx" collapse control.
 *
 * Rendered inside the group header (`GroupHeaderRenderer`), positioned below
 * the user message for every completed turn that has body items. Clicking the chevron
 * toggles the collapse state in `turnCollapseOverrideAtom`; when
 * collapsed, `GroupItemRenderer` hides every non-final-assistant item
 * in the group so only the closing agent message remains visible —
 * matching the Cursor CLI agent's post-turn UX.
 *
 * Visual style intentionally stays weaker than regular event block headers:
 * this is a turn-boundary summary/control, not another tool/card block. Keeping
 * it subtle prevents the many per-event collapsible headers from visually
 * merging with the per-turn collapse affordance.
 *
 * Completed turns are collapsed by default; the override atom only
 * records explicit user toggles. The currently active (tail) turn is
 * never collapsed while the agent is still streaming.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { getTurnTimingLabels } from "@src/engines/ChatPanel/ChatHistory/utils/turnTimingFormatting";
import {
  collapseAllCommandAtom,
  setTurnCollapseOverrideAtom,
  turnCollapseOverrideAtom,
} from "@src/store/ui/collapseStateAtom";

export interface TurnCollapsePinBarProps {
  /** User-message event id at the head of this turn. */
  turnId: string;
  /** Span from user message to last group item, in milliseconds. */
  durationMs: number;
  /** Epoch ms of the user-message kicking off the turn. `null` hides the range. */
  startMs: number | null;
  /** Epoch ms of the last item in the turn. `null` hides the range. */
  endMs: number | null;
  /** Whether to show the `HH:MM - HH:MM` range subtitle. */
  showTimeRange?: boolean;
  /** Group chat spans multiple org members, so the collapse label is plural. */
  labelVariant?: "agent" | "agents";
  /** Default collapse state for this turn (true for completed turns). */
  defaultCollapsed: boolean;
  turnCollapseInteractionAtRef: React.MutableRefObject<number>;
  /** Called before expanding a lazy-loaded turn. */
  onExpand?: () => Promise<void> | void;
}

const CHEVRON_SIZE = 14;

const TurnCollapsePinBar: React.FC<TurnCollapsePinBarProps> = memo(
  ({
    turnId,
    durationMs,
    startMs,
    endMs,
    showTimeRange = true,
    labelVariant = "agent",
    defaultCollapsed,
    turnCollapseInteractionAtRef,
    onExpand,
  }) => {
    const { t } = useTranslation("sessions");
    const overrideMap = useAtomValue(turnCollapseOverrideAtom);
    const collapseAllCommand = useAtomValue(collapseAllCommandAtom);
    const setOverride = useSetAtom(setTurnCollapseOverrideAtom);
    const [isLoading, setIsLoading] = useState(false);

    const override = overrideMap.get(turnId);
    const forcedCollapsed =
      collapseAllCommand.epoch > 0 && collapseAllCommand.collapsed
        ? true
        : undefined;
    const collapsed = override ?? forcedCollapsed ?? defaultCollapsed;
    const expanded = !collapsed;

    const handleToggle = useCallback(async () => {
      if (isLoading) return;
      turnCollapseInteractionAtRef.current = performance.now();
      const nextCollapsed = !collapsed;
      if (!nextCollapsed && onExpand) {
        setIsLoading(true);
        try {
          await onExpand();
        } finally {
          setIsLoading(false);
        }
      }
      // Clear the override when it matches the effective command/default
      // fallback so the map stays small while preserving manual toggles after
      // a bulk collapse/expand command.
      const fallbackCollapsed = forcedCollapsed ?? defaultCollapsed;
      const nextValue =
        nextCollapsed === fallbackCollapsed ? undefined : nextCollapsed;
      setOverride({ turnId, collapsed: nextValue });
    }, [
      collapsed,
      defaultCollapsed,
      forcedCollapsed,
      isLoading,
      onExpand,
      setOverride,
      turnCollapseInteractionAtRef,
      turnId,
    ]);

    const labelKey =
      labelVariant === "agents"
        ? "tools.turnCollapse.agentsWorkedFor"
        : "tools.turnCollapse.agentWorkedFor";
    const timing = getTurnTimingLabels(durationMs, startMs, endMs);
    const label = t(labelKey, {
      value: timing.duration,
    });

    const showRange = showTimeRange && timing.showRange;
    const rangeLabel = showRange
      ? t("tools.turnCollapse.timeRange", {
          start: timing.startClock,
          end: timing.endClock,
        })
      : "";

    // Static chevron: ChevronsUpDown → "click to expand" (collapsed state),
    // ChevronsDownUp → "click to collapse" (expanded state). No hover swap.
    const ChevronIcon = expanded ? ChevronsDownUp : ChevronsUpDown;

    return (
      <button
        type="button"
        aria-expanded={expanded}
        className="group/turn-collapse chat-block-header mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2 text-left transition-colors hover:bg-fill-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30"
        onClick={(event) => {
          event.stopPropagation();
          void handleToggle();
        }}
      >
        <ChevronIcon
          size={CHEVRON_SIZE}
          strokeWidth={1.75}
          className="shrink-0 text-text-2 transition-colors group-hover/turn-collapse:text-text-1"
        />
        <span className="inline-flex min-w-0 flex-1 items-center gap-2 leading-tight">
          <span className="shrink-0 whitespace-nowrap font-medium text-text-2 transition-colors group-hover/turn-collapse:text-text-1">
            {label}
          </span>
          {showRange && (
            <span className="min-w-0 truncate text-text-3">{rangeLabel}</span>
          )}
        </span>
      </button>
    );
  }
);

TurnCollapsePinBar.displayName = "TurnCollapsePinBar";

export default TurnCollapsePinBar;
