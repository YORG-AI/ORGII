/**
 * AgentStatusTrail
 *
 * The line that closes the conversation. It is always there once a session
 * has a turn, in one of two readings:
 *
 *   ◼  Agent working for 1h 20m 26s · Agent is typing...
 *   ◼  Waiting for your reply
 *   ◼  Agent is idle                   (a session ORGII runs)
 *   ◼  Last refreshed 5 minutes ago    (an imported transcript)
 *
 * The trailing phrase is what used to be `PlanningFooter`'s own row directly
 * above this one. Two stacked lines saying related things about one running
 * round read as clutter, so the phrase became this line's second segment and
 * the transcript now ends with exactly one live row.
 *
 * Live context usage is deliberately NOT here — the composer's context pill
 * already carries it, and this line answers "is it still going, and for how
 * long".
 *
 * It sits at the very end of the transcript, below the planning line, and is
 * deliberately NOT part of any turn's collapsible body — a turn folds away,
 * this does not, so the readout stays put while the agent works and the mark
 * stays put once it stops.
 *
 * The leading glyph is the session's own harness mark, rendered through
 * `SessionIdentityIcon` — the same projection behind the sidebar row, the
 * chat-panel tab, and the spotlight hit, so a Codex session shows the Codex
 * mark, an imported Cursor session shows Cursor's, and ORGII's native agent
 * shows the ORG2 logo. It breathes on a slow pulse while a round runs — no
 * spinner competing with the tool blocks above — and rests, dimmed and
 * still, otherwise. That contrast is what carries the state, so the phases
 * are never confusable at a glance.
 *
 * Which phase applies is the SESSION's status, resolved by the same rules
 * the sidebar dot uses (see `resolveTrailPhase`), so the mark at the end of
 * the transcript and the dot in the sidebar can never disagree.
 *
 * Data comes from `useAgentStatusTrail`; a segment is dropped rather than
 * shown as a zero or an unknown, so a round whose start is not known degrades
 * to a bare `Agent working`.
 */
import { useAtomValue } from "jotai";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import type { PlanningIndicatorMode } from "@src/engines/ChatPanel/blocks/primitives/chatActivityLabel";
import { pickPlanningVariant } from "@src/engines/ChatPanel/blocks/primitives/chatActivityLabel";
import SessionIdentityIcon from "@src/engines/ChatPanel/components/SessionIdentityIcon";
import {
  type AgentStatusTrailState,
  formatTrailElapsed,
  resolveTrailElapsedMs,
  resolveTrailRestLabel,
} from "@src/engines/ChatPanel/hooks/agentStatusTrailMath";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { CHAT_ITEM_GAP, CHAT_ITEM_PADDING_X } from "./config";

/** Tick cadence for the elapsed readout. Whole seconds are all it renders. */
const TRAIL_TICK_MS = 1000;

/**
 * Tick cadence for the "last refreshed X ago" readout. Its coarsest unit is
 * the minute, so a half-minute beat keeps it honest without waking the row
 * more than a session that may sit idle for hours can justify.
 */
const REFRESHED_TICK_MS = 30_000;

/**
 * A wall-clock reading that refreshes on `intervalMs` while `active`, and is
 * `null` otherwise.
 *
 * The clock lives HERE rather than in `useAgentStatusTrail` so the value that
 * changes on a timer never enters `ChatHistoryList`'s memoized props — only
 * this leaf row re-renders on the tick.
 *
 * `now` is written solely from the timer callbacks, never synchronously in
 * the effect body, so the render below stays pure (no `Date.now()` during
 * render) — the same discipline `useStreamingHud` follows.
 */
function useTickingNow(active: boolean, intervalMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!active) {
      const closeTimer = setTimeout(() => setNow(null), 0);
      return () => clearTimeout(closeTimer);
    }

    const openTimer = setTimeout(() => setNow(Date.now()), 0);
    const interval = setInterval(() => setNow(Date.now()), intervalMs);

    return () => {
      clearTimeout(openTimer);
      clearInterval(interval);
    };
  }, [active, intervalMs]);

  return now;
}

export interface AgentStatusTrailProps {
  state: AgentStatusTrailState;
  /** Session whose agent mark leads the line. */
  sessionId: string | null;
  /** 1 while `usePlanningIndicator` says the activity phrase should show. */
  planningCount: number;
  /** Stable index into the localized planning-variant array. */
  planningVariantIndex: number;
  planningMode: PlanningIndicatorMode;
}

/**
 * The session's harness mark, wrapped in the phase's motion.
 *
 * `SessionIdentityIcon` owns which glyph that is — it runs the same
 * `resolveSessionRowIconPresentation` projection as the sidebar row, so
 * provider identity, imported-history sources, and the monochrome-brand
 * color rule are resolved in exactly one place for the whole app.
 */
const TrailAgentIcon: React.FC<{
  sessionId: string | null;
  isRunning: boolean;
}> = ({ sessionId, isRunning }) => {
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));

  // Resting holds the mark at the pulse's own low point (opacity .5,
  // scale .9) so switching phases changes only whether it moves, never where
  // it sits — no jump at the moment a round starts or ends.
  const motionClass = isRunning
    ? "animate-agent-pulse motion-reduce:animate-none"
    : "scale-90 opacity-50";

  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 shrink-0 items-center justify-center transition-opacity duration-300 ${motionClass}`}
    >
      <SessionIdentityIcon
        session={session}
        sessionId={sessionId ?? ""}
        isSelected={false}
      />
    </span>
  );
};

const AgentStatusTrail: React.FC<AgentStatusTrailProps> = ({
  state,
  sessionId,
  planningCount,
  planningVariantIndex,
  planningMode,
}) => {
  const { t } = useTranslation("sessions");
  const isRunning = state.phase === "running";
  const restLabel = resolveTrailRestLabel(state);
  const showsRefreshedAt =
    !isRunning && state.phase !== "asking" && restLabel === "lastRefreshed";

  const runningNow = useTickingNow(isRunning, TRAIL_TICK_MS);
  const refreshedNow = useTickingNow(showsRefreshedAt, REFRESHED_TICK_MS);
  const elapsedMs =
    runningNow === null
      ? null
      : resolveTrailElapsedMs(state.startedAtMs, runningNow);
  // `formatRelativeTime` reads the clock itself, so `refreshedNow` is not an
  // argument — it is the freshness key that makes this recompute on the
  // tick instead of freezing at whatever "x ago" was true on mount.
  const refreshedAgo = useMemo(
    () =>
      showsRefreshedAt
        ? formatRelativeTime(state.lastRefreshedAtMs, "long")
        : "",
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshedNow is a deliberate freshness key; see above.
    [showsRefreshedAt, state.lastRefreshedAtMs, refreshedNow]
  );

  if (state.phase === "hidden") return null;

  // What the agent is doing right now, if the planning indicator has settled
  // on something to say. Absent between beats — it hides itself for a second
  // after every store mutation — which is exactly why it cannot be the only
  // thing on this row.
  const activityText =
    planningCount > 0
      ? planningMode === "compacting"
        ? t("planning.compacting", "Compacting context...")
        : planningMode === "agentTyping"
          ? t("planning.agentTyping", "Agent is typing...")
          : pickPlanningVariant(
              t("planning.nextStepVariants", { returnObjects: true }),
              planningVariantIndex,
              "Planning next step..."
            )
      : "";

  const segments: string[] = [];
  if (isRunning) {
    // Pairs with the finished turn's "Agent worked for X" collapse bar: the
    // same sentence in the present tense, counting the same span.
    segments.push(
      elapsedMs === null
        ? t("planning.statusTrail.agentWorking")
        : t("planning.statusTrail.agentWorkingFor", {
            value: formatTrailElapsed(elapsedMs),
          })
    );
  } else {
    // Resting only: a `background` shell outlives the round that started it,
    // and a bare "Agent is idle" while two of them are still alive would be
    // false. A running round already says work is happening.
    if (state.runningTasks > 0) {
      segments.push(
        t("planning.statusTrail.runningTask", { count: state.runningTasks })
      );
    }
    // An activity in flight contradicts "idle", so it REPLACES the resting
    // label rather than sitting next to it. Manual compaction is the case
    // that reaches here: it names itself even when the runtime status has
    // not (or no longer) flipped to running.
    const restText = activityText
      ? ""
      : state.phase === "asking"
        ? t("planning.statusTrail.asking")
        : showsRefreshedAt
          ? t("planning.statusTrail.lastRefreshed", { value: refreshedAgo })
          : restLabel === "agentIdle"
            ? t("planning.statusTrail.idle")
            : // External, with no scan on record: the mark stands alone
              // rather than claiming an idleness ORGII cannot observe.
              "";
    if (restText) segments.push(restText);
  }
  if (activityText) segments.push(activityText);

  return (
    <div
      className={`chat-font-size-wrapper allow-select-deep ${CHAT_ITEM_GAP} ${CHAT_ITEM_PADDING_X} ${CHAT_PANEL_WIDTH_TOKENS.contentWidth}`}
      data-testid="agent-status-trail"
      data-trail-phase={state.phase}
    >
      {/* Row metrics mirror `EventBlockHeader` exactly (h-[36px], px-2,
          gap-2) so the trail's glyph and text line up with the planning
          row directly above it instead of stepping in by a pixel or two. */}
      <div className="chat-block-header flex h-[36px] w-full items-center gap-2 px-2">
        <TrailAgentIcon sessionId={sessionId} isRunning={isRunning} />
        {/* The state itself reads at text-2; the activity phrase and the
            separators stay a step back at text-3, so "Agent working for 31s"
            still leads the line when a long phrase follows it. */}
        <span className="min-w-0 flex-1 truncate leading-tight text-text-2 select-none">
          {segments.map((segment, index) => (
            <React.Fragment key={segment}>
              {index > 0 ? <span className="text-text-3">{" · "}</span> : null}
              <span
                className={segment === activityText ? "text-text-3" : undefined}
              >
                {segment}
              </span>
            </React.Fragment>
          ))}
        </span>
      </div>
    </div>
  );
};

AgentStatusTrail.displayName = "AgentStatusTrail";

export default React.memo(AgentStatusTrail);
