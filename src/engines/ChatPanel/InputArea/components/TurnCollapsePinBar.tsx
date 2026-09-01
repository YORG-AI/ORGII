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
 * A hairline rule sits directly below the bar so each turn boundary reads as a
 * separated section (matching the Codex transcript layout) instead of the label
 * floating between two runs of message content.
 *
 * Visual style intentionally stays weaker than regular event block headers:
 * this is a turn-boundary summary/control, not another tool/card block. Keeping
 * it subtle prevents the many per-event collapsible headers from visually
 * merging with the per-turn collapse affordance.
 *
 * Completed turns are collapsed by default; the override atom only
 * records explicit user toggles. The currently active (tail) turn is
 * never collapsed while the agent is still streaming; once its round ends
 * (tail phase "complete") the bar renders immediately — wall-clock
 * start→end duration, no wait, no size threshold — with the turn still
 * expanded, and once the session goes stale (phase "stale": last event
 * older than `TAIL_TURN_STALE_MS`, most likely finished) the turn defaults
 * to collapsed like a historical one.
 *
 * Hover reveals a navigate icon that jumps to this turn in WorkStation replay.
 * Hidden inside the Simulator Messages replay surface (no-op jump).
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { getTurnTimingLabels } from "@src/engines/ChatPanel/ChatHistory/utils/turnTimingFormatting";
import EventNavigateIcon from "@src/engines/ChatPanel/blocks/primitives/EventNavigateIcon";
import { InSimulatorReplayContext } from "@src/engines/ChatPanel/blocks/primitives/inSimulatorReplayContext";
import { useChatEventReplay } from "@src/engines/ChatPanel/hooks/useChatEventReplay";
import { createLogger } from "@src/hooks/logger";
import { ChevronsDownUpIcon, UnfoldMoreIcon } from "@src/icons";
import {
  collapseAllCommandAtom,
  setTurnCollapseOverrideAtom,
  turnCollapseOverrideAtom,
} from "@src/store/ui/collapseStateAtom";

const log = createLogger("TurnCollapsePinBar");

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
    const inSimulatorReplay = useContext(InSimulatorReplayContext);
    const { replayEventById, canReplay } = useChatEventReplay();
    const overrideMap = useAtomValue(turnCollapseOverrideAtom);
    const collapseAllCommand = useAtomValue(collapseAllCommandAtom);
    const setOverride = useSetAtom(setTurnCollapseOverrideAtom);
    const [isLoading, setIsLoading] = useState(false);
    const showReplayNavigate = canReplay && !inSimulatorReplay;

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
        } catch (error) {
          // `onExpand` (GroupHeaderRenderer's handleExpandUnloadedTurn)
          // already catches its own failures, but this handler is invoked
          // via `void handleToggle()` from the onClick below — an
          // uncaught rejection here would become an unhandled promise
          // rejection that the app's GlobalErrorHandler escalates to the
          // fatal, full-screen error page. Defense in depth: swallow it so
          // one failed lazy-load never crashes the whole app, and leave
          // the bar interactive (isLoading resets in `finally`) so the
          // user can just click again.
          log.warn(`Turn expand failed for ${turnId}:`, error);
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

    const handleReplayNavigate = useCallback(() => {
      replayEventById(turnId);
    }, [replayEventById, turnId]);

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
    const ChevronIcon = expanded ? ChevronsDownUpIcon : UnfoldMoreIcon;

    return (
      <div className="mt-1">
        <div className="group/turn-collapse group/chat-block-header chat-block-header flex h-8 w-full items-center gap-1 rounded-lg px-2 transition-colors hover:bg-fill-2">
          <button
            type="button"
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-0 text-left focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none"
            onClick={(event) => {
              event.stopPropagation();
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed) return;
              void handleToggle();
            }}
          >
            <AnyIcon
              icon={ChevronIcon}
              size={CHEVRON_SIZE}
              strokeWidth={1.75}
              className="shrink-0 text-text-2 transition-colors group-hover/turn-collapse:text-text-1"
            />
            <span className="inline-flex min-w-0 flex-1 items-center gap-2 leading-tight select-none">
              <span className="shrink-0 font-medium whitespace-nowrap text-text-2 transition-colors group-hover/turn-collapse:text-text-1">
                {label}
              </span>
              {showRange && (
                <span className="min-w-0 truncate text-text-3">
                  {rangeLabel}
                </span>
              )}
            </span>
          </button>
          {showReplayNavigate ? (
            <EventNavigateIcon
              onClick={handleReplayNavigate}
              ariaLabel={t("tools.replay.title")}
            />
          ) : null}
        </div>
        <div aria-hidden="true" className="h-px w-full bg-border-1" />
      </div>
    );
  }
);

TurnCollapsePinBar.displayName = "TurnCollapsePinBar";

export default TurnCollapsePinBar;
