/**
 * SubagentChatPane
 *
 * Drop-in replacement for `SubagentEventPane` inside subagent grid cells.
 * Instead of routing a single replay-cursor event to CodePanel /
 * CompactEventView, this pane renders the chat stream for the subagent
 * session using the same `ChatHistory` component the main chat panel
 * uses — wrapped in a `ChatSessionContext.Provider` so the chat events
 * atom is scoped to this subagent (not the globally-active session).
 *
 * Replay semantics
 *
 * When the cell's replay slider is anywhere except the live tail, the
 * pane must show ONLY events that already happened up to that point. We
 * achieve that by reading the session-scoped chat events here, slicing
 * them at `cursorMs`, and pushing the slice through
 * `ChatHistoryOverrideContext`. `useChatHistory()` reads the override
 * first, so ChatHistory renders exactly the sliced array. When the
 * cursor is at the live tail (or absent), we pass no override and
 * ChatHistory follows streaming normally.
 *
 * Per-turn user prompt card ("pinned message") — hidden
 *
 * Per-turn collapse — disabled
 *
 * In turn-pagination mode every page is exactly one turn, which means
 * the currently-rendered group is always the "tail" group. The main
 * ChatPanel collapses tail groups once the session idles (the "Agent
 * worked for X" pin bar), which is the wrong default for a subagent
 * cell: the whole point of the cell is to show the latest events for
 * that subagent, not to hide them behind a collapse pin. We opt out
 * via `disableTailCollapse` so the active round always renders
 * expanded with the new-event divider visible.
 *
 * Every turn group is rendered with a sticky user-message header at
 * the top (the "Task assigned by Coordinator: …" card — actually
 * `GroupHeaderRenderer` → `<UserChatItem>`). For subagent cells those
 * cards are noise — the user already knows what was assigned, and the
 * inline chat replays each turn anyway. We permanently suppress them
 * via `hideGroupUserMessage`; the "Agent worked for X" collapse pin
 * (`TurnCollapsePinBar`, same renderer, separate branch) stays
 * visible because it's the only "where am I in this turn" affordance
 * left.
 *
 * A trailing `(i)` Info button injected into `TurnPaginationControls`
 * (via `paginationTrailingSlot`) opens a popover showing the original
 * task prompt — see `SubagentPromptToggle`. A collapse-all button
 * next to it calls the same global atom the main ChatPanel header
 * uses. Todo progress stays on the parent composer and the cell's scoped
 * title-row preview rather than appearing inside this chat history.
 *
 * "New event" divider
 *
 * The newest event in each surviving turn is signposted with a
 * `---- New event ----` divider via `newEventDividerLabel`, mirroring
 * the Communication > messages "new message" affordance. No tail
 * windowing — `useChatGroups`' force-collapse + turn pagination
 * already cap each cell's rendered items per round, so an extra
 * windowing layer here would add complexity without meaningful RAM
 * savings (the event store atom holds the same set either way).
 *
 * The pane never renders an `InputArea` — composing replies to subagents
 * is a separate, deferred concern. The cell stays read-only.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import ChatHistory from "@src/engines/ChatPanel/ChatHistory";
import { ChatHistoryOverrideContext } from "@src/engines/ChatPanel/ChatHistoryOverrideContext";
import { ChatSessionContext } from "@src/engines/ChatPanel/ChatSessionContext";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { findIndexAtTime } from "@src/engines/Simulator/utils/findIndexAtTime";
import { HugeiconsIcon, ListChevronsDownUpIcon } from "@src/icons";
import { setAllBlocksCollapsedAtom } from "@src/store/ui/collapseStateAtom";

import { SubagentPromptToggle } from "./SubagentPromptToggle";

interface SubagentChatPaneProps {
  /** Subagent session id — passed to ChatSessionContext so the chat events
   *  atom routes to `chatEventsForSessionAtomFamily(sessionId)`. */
  sessionId: string;
  /** Replay cursor timestamp in epoch ms. When set, chat events are
   *  sliced to only include events with `createdAt <= cursorMs`. When
   *  `null`, no slicing is applied (live tail). */
  cursorMs?: number | null;
  /** Backend-authoritative liveness (clip still open). Combined with the
   *  live-tail check to scope the planning footer: a finished subagent or
   *  a scrubbed historical view must never animate "Planning next step…". */
  isSessionLive?: boolean;
}

const SubagentChatPaneComponent: React.FC<SubagentChatPaneProps> = ({
  sessionId,
  cursorMs = null,
  isSessionLive = false,
}) => {
  const { t } = useTranslation("sessions");
  // Subscribe at this layer so we can slice before passing into ChatHistory.
  // ChatHistory re-reads via `useChatHistory()` and picks up our override.
  const allEvents = useAtomValue(chatEventsForSessionAtomFamily(sessionId));

  const setAllBlocksCollapsed = useSetAtom(setAllBlocksCollapsedAtom);
  const handleCollapseAll = useCallback(() => {
    setAllBlocksCollapsed(true);
  }, [setAllBlocksCollapsed]);

  // Slice events to the replay cursor. When `cursorMs` is null OR the
  // cursor is at/past the last event, we pass `undefined` so the
  // ChatHistory pipeline reads the full array directly from the atom
  // (live-tail mode, no override allocation). Uses the canonical
  // `findIndexAtTime` so pre-spawn semantics match the rest of the
  // replay subsystem: `preStart: "empty"` → an empty slice when the
  // cursor is before any chat event.
  const slicedEvents = useMemo(() => {
    if (cursorMs == null) return undefined;
    if (allEvents.length === 0) return undefined;
    // Fast path: cursor at/past last event → no slice, full live render.
    const lastCreatedAt = allEvents[allEvents.length - 1].createdAt;
    const lastMs = Date.parse(lastCreatedAt);
    if (Number.isFinite(lastMs) && cursorMs >= lastMs) return undefined;

    const idx = findIndexAtTime(allEvents, cursorMs, { preStart: "empty" });
    if (idx < 0) return [];
    return allEvents.slice(0, idx + 1);
  }, [allEvents, cursorMs]);

  // When the session has no events at all (yet), render a minimal static
  // placeholder instead of routing into ChatHistory. ChatHistory's empty
  // path surfaces a "Session data may not have loaded — Reload" prompt
  // which is the wrong affordance for a subagent cell that simply hasn't
  // produced any output yet (or whose owner hasn't been delegated a
  // task). Same placeholder fires when the active slice is empty (cursor
  // before the first event), so a blank ChatHistory render is structurally
  // impossible regardless of timestamp domain.
  const isEmpty =
    allEvents.length === 0 ||
    (slicedEvents !== undefined && slicedEvents.length === 0);
  if (isEmpty) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-chat-pane px-4 text-center">
        <span className="text-[12px] text-text-3">
          {t("simulator.subagentPane.waitingForActivity", {
            defaultValue: "Waiting for activity…",
          })}
        </span>
      </div>
    );
  }

  // Subagent cells default to *paginated* turn view: a single turn per
  // page with prev/next/page-list controls along the top. This is the
  // dense overview the user wants — instead of force-collapsing every
  // turn and stacking dozens of "show messages" rows, the pagination
  // bar IS the affordance for moving between turns. The agent / member
  // pills inside `TurnPaginationControls` self-hide when no
  // `agentOrgMembers` / `agentName` / overview panel is supplied (none
  // are here), so the row collapses down to just the turn pager.
  //
  // Trailing slot: an `(i)` Info button that opens a popover anchored
  // to it, showing the original task prompt (the subagent's first
  // user-source event), and a collapse-all button. The Info button
  // owns its own popover state — see `SubagentPromptToggle`.
  const paginationTrailingSlot = (
    <>
      <SubagentPromptToggle sessionId={sessionId} />
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        data-testid="subagent-collapse-all"
        onClick={handleCollapseAll}
        title={t("chat.collapseAll")}
        aria-label={t("chat.collapseAll")}
        icon={
          <HugeiconsIcon
            icon={ListChevronsDownUpIcon}
            data-icon="list-chevrons-down-up"
            size={16}
            strokeWidth={2}
          />
        }
      />
    </>
  );

  const newEventDividerLabel = t("simulator.subagentPane.newEventDivider", {
    defaultValue: "New event",
  });

  // Footer scope: live only while the session is actually running AND the
  // pane is at the live tail (no replay slice). `slicedEvents !== undefined`
  // means a historical cursor is active — the footer would animate over a
  // frozen frame and lie.
  const planningIndicatorScope = {
    sessionId,
    isLive: isSessionLive && slicedEvents === undefined,
  };

  return (
    <ChatSessionContext.Provider value={sessionId}>
      <ChatHistoryOverrideContext.Provider value={slicedEvents}>
        <ChatProvider>
          <div className="relative flex h-full w-full flex-col overflow-hidden">
            <div className="relative min-h-0 flex-1 overflow-hidden">
              <ChatHistory
                surfaceBgClass="bg-chat-pane"
                turnPaginationEnabled
                disableTailCollapse
                hideGroupUserMessage
                paginationTrailingSlot={paginationTrailingSlot}
                newEventDividerLabel={newEventDividerLabel}
                planningIndicatorScope={planningIndicatorScope}
              />
            </div>
          </div>
        </ChatProvider>
      </ChatHistoryOverrideContext.Provider>
    </ChatSessionContext.Provider>
  );
};

export const SubagentChatPane = memo(SubagentChatPaneComponent);
SubagentChatPane.displayName = "SubagentChatPane";
