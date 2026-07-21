/**
 * NestedActivityList — session-in-session event renderer.
 *
 * Runs the full `processChatItems` pipeline (with grouping enabled)
 * and renders each item through the same dispatcher as the main
 * ChatHistory: readFileGroup, actionSummaryGroup, activityStackGroup,
 * and plain activity items all render identically to the parent panel.
 *
 * Two display modes:
 *  - `interactive={false}` (default): wraps in NestedBlockContext so
 *    deeply nested blocks are force-collapsed.
 *  - `interactive={true}` (SubagentDetailTab full-page view): blocks
 *    behave like the main chat panel.
 *
 * For consumers that only have a `subagentSessionId`, use the
 * `NestedActivityListForSession` convenience wrapper.
 */
import React, { memo, useEffect, useMemo, useState } from "react";

import {
  type OptimizedChatItem,
  processChatItems,
} from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline";
import {
  renderActionSummaryGroup,
  renderActivity,
  renderActivityStackGroup,
  renderReadFileGroup,
} from "@src/engines/ChatPanel/ChatHistory/renderers/ExtendedItemRenderers";
import { useSessionEvents } from "@src/engines/SessionCore/core/store/useSessionEvents";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { findIndexAtTime } from "@src/engines/Simulator/utils/findIndexAtTime";

import { ChatLoadingBlock } from "../primitives";
import { NestedBlockContext } from "../primitives/nestedBlockContext";

const REVEAL_INTERVAL_MS = 50;

/**
 * Stagger the display of simultaneously-arriving events so they appear
 * one-at-a-time instead of in bursts.  On mount, all existing items render
 * immediately (useState initialises to totalCount).  When new items arrive
 * faster than REVEAL_INTERVAL_MS, a timer reveals one more item per tick.
 */
function useProgressiveReveal(totalCount: number): number {
  const [revealed, setRevealed] = useState(totalCount);

  // Snap down when totalCount shrinks (session change / reset).
  // Using the render-time pattern avoids the eslint set-state-in-effect rule.
  const clamped = Math.min(revealed, totalCount);
  if (clamped < revealed) {
    setRevealed(clamped);
  }

  useEffect(() => {
    if (revealed >= totalCount) return;
    const timer = setTimeout(() => {
      setRevealed((r) => Math.min(r + 1, totalCount));
    }, REVEAL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [revealed, totalCount]);

  return clamped;
}

interface NestedActivityListProps {
  events: SessionEvent[];
  loading?: boolean;
  interactive?: boolean;
  /**
   * When set, only events with `createdAt <= externalCursorMs` are rendered.
   * Used by `SubagentBlock` to replay the child session up to the main drag
   * bar's cursor position. `null`/`undefined` means "show all events" (the
   * live / follow-mode behaviour).
   *
   * Empty-string sentinel is not used — callers should pass `null`/omit when
   * no cursor is active. Note that `findIndexAtTime` clamps before-start to
   * index 0; we treat "cursor strictly before the first event" as "render
   * nothing" instead, so the list is empty when scrubbed pre-spawn.
   */
  externalCursorMs?: number | null;
}

function renderNestedItem(
  item: OptimizedChatItem,
  index: number
): React.ReactElement | null {
  const key = item.chunk_id || `nested-${index}`;
  switch (item.type) {
    case "activity":
      return renderActivity(item, index, key);
    case "readFileGroup":
      return renderReadFileGroup(item, key);
    case "actionSummaryGroup":
      return renderActionSummaryGroup(item, key);
    case "activityStackGroup":
      return renderActivityStackGroup(item, key);
    default:
      return null;
  }
}

const NestedActivityList: React.FC<NestedActivityListProps> = memo(
  ({
    events,
    loading = false,
    interactive = false,
    externalCursorMs = null,
  }) => {
    // When the parent passes a replay cursor, clip the child event stream to
    // events that existed at that timestamp. The slice happens *before*
    // processChatItems so grouping (read_file groups, action summaries) sees
    // a consistent prefix and doesn't fold events that haven't "happened"
    // yet at cursor T. Pre-spawn semantics: `preStart: "empty"` so cursor
    // before the first event renders nothing (the "not started" placeholder
    // branch below).
    const slicedEvents = useMemo(() => {
      if (externalCursorMs == null || events.length === 0) return events;
      const idx = findIndexAtTime(events, externalCursorMs, {
        preStart: "empty",
      });
      if (idx < 0) return [];
      return events.slice(0, idx + 1);
    }, [events, externalCursorMs]);

    const renderable = useMemo(() => {
      // Disable preFilterEmptyActivities so running tool_call events
      // (read_file, edit_file, etc.) are visible while the subagent works.
      const { items } = processChatItems(slicedEvents, {
        preFilterEmptyActivities: false,
      });
      return items.filter(
        (item) =>
          item.type === "activity" ||
          item.type === "readFileGroup" ||
          item.type === "actionSummaryGroup" ||
          item.type === "activityStackGroup"
      );
    }, [slicedEvents]);

    // In replay mode the cursor jumps non-monotonically (back, forward, big
    // hops) — running a 50 ms-per-item reveal animation would visibly stagger
    // every scrub. Always pass the true total to the hook (so its internal
    // state stays in sync if the user toggles back to follow mode), but
    // override the displayed count to "snap to full" while a cursor is set.
    const inReplayMode = externalCursorMs != null;
    const revealedLive = useProgressiveReveal(renderable.length);
    const revealed = inReplayMode ? renderable.length : revealedLive;
    const visibleItems =
      revealed < renderable.length ? renderable.slice(0, revealed) : renderable;

    if (visibleItems.length === 0) {
      if (loading) {
        return (
          <div className="px-3.5 py-2">
            <ChatLoadingBlock />
          </div>
        );
      }
      return null;
    }

    const body = (
      <div className="flex flex-col gap-1 px-3.5 py-2">
        {visibleItems.map((item, index) => renderNestedItem(item, index))}
      </div>
    );

    if (interactive) return body;

    return (
      <NestedBlockContext.Provider value={true}>
        {body}
      </NestedBlockContext.Provider>
    );
  }
);
NestedActivityList.displayName = "NestedActivityList";

/**
 * Convenience wrapper that subscribes to a subagent session via
 * `useSessionEvents` and forwards the events to the pure
 * `NestedActivityList`.
 */
export const NestedActivityListForSession: React.FC<{
  subagentSessionId: string;
  interactive?: boolean;
  externalCursorMs?: number | null;
}> = memo(({ subagentSessionId, interactive, externalCursorMs = null }) => {
  const { events, loading } = useSessionEvents(subagentSessionId);
  return (
    <NestedActivityList
      events={events}
      loading={loading}
      interactive={interactive}
      externalCursorMs={externalCursorMs}
    />
  );
});
NestedActivityListForSession.displayName = "NestedActivityListForSession";

export default NestedActivityList;
