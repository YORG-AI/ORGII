/**
 * A session referenced by a posted channel message, rendered as a card.
 *
 * Chrome (border, width, hover, chevron) comes from `ChannelReferenceCard`,
 * shared with the work-item and GitHub cards. What is local to this file is
 * the session's own body and its snapshot-only fallback.
 *
 * Visual grammar follows the Kanban `TaskCard` — agent icon + title row, then
 * a footer meta strip — but the card is built here rather than imported:
 * `TaskCard` carries board behaviour (drag, column moves, selection accent,
 * priority/labels) that a transcript row has no use for. What IS reused is
 * the data side: `sessionToKanbanTask` projects the session exactly as the
 * board sees it (title with pill references stripped, agent identity, model,
 * tokens, workspace), so a channel card can never disagree with the board
 * about a session.
 *
 * The status dot is deliberately NOT derived from the board column: it runs
 * the sidebar's derivation (`resolveSessionStatusDotTone` + the breathing
 * marker for in-progress work) so one session shows the same dot in the
 * sidebar row and on the card.
 *
 * Round count comes from `useSessionTurnOverview`, the same derivation the
 * session hover card uses. That hook keeps a module-level cache keyed by
 * session id plus in-flight coalescing, so N cards naming one session share a
 * single load and a re-mount inside the virtualized transcript is free — no
 * extra memoization is needed at this layer.
 *
 * Live status reads `sessionByIdAtom`, never `sessionsAtom`: one card must
 * not re-render every time any session in the app changes.
 */
import { useAtomValue } from "jotai";
import { FolderGit2, Repeat } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { useSessionTurnOverview } from "@src/components/SessionHoverCard/useSessionTurnOverview";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { sessionToKanbanTask } from "@src/features/TaskKanban/hooks/useKanbanTasks/sessionToKanbanTask";
import {
  renderBreathingStatusDot,
  renderStatusDot,
} from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/statusIndicators";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { visitedSessionsAtom } from "@src/store/session/visitedSessionsAtom";
import { formatModelNameFull } from "@src/util/formatModelName";
import { isSessionInProgress } from "@src/util/session/sessionInProgress";
import {
  isSessionPendingAsking,
  resolveSessionStatusDotTone,
} from "@src/util/session/sessionStatusDot";

import {
  ChannelReferenceCard,
  ChannelReferenceCardMeta,
  ChannelReferenceCardMetaItem,
  ChannelReferenceCardTitle,
} from "./ChannelReferenceCard";

/**
 * The projection takes archive inputs a transcript card has no opinion on: a
 * referenced session is never "archived" just because the board would shelve
 * it. `never` disables the TTL rule, which in turn makes `nowMs` unread — so
 * it is pinned to 0 rather than reaching for the clock during render.
 */
const NO_SESSION_IDS: ReadonlySet<string> = new Set<string>();
const NO_AUTO_ARCHIVE_NOW_MS = 0;

const CARD_TEST_ID = "channel-session-card";

export interface ChannelSessionCardProps {
  sessionId: string;
  /** Title as posted — enough to keep a cold/sidebar-only row identifiable. */
  fallbackTitle: string;
  onOpen: (sessionId: string, fallbackTitle?: string) => void;
}

/**
 * Resolved outside the component, the way `TaskCard.renderAgentIcon` does it:
 * `resolveAgentIcon` returns a component type, and producing one during a
 * component's render remounts the subtree on every pass.
 */
function renderAgentIcon(iconId: string | undefined) {
  const AgentIcon = resolveAgentIcon(iconId);
  return <AgentIcon size={12} strokeWidth={1.75} />;
}

const ChannelSessionCard: React.FC<ChannelSessionCardProps> = ({
  sessionId,
  fallbackTitle,
  onOpen,
}) => {
  const { t } = useTranslation("navigation");
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const turnOverview = useSessionTurnOverview(sessionId);

  const task = useMemo(
    () =>
      session
        ? sessionToKanbanTask(
            session,
            NO_SESSION_IDS,
            NO_SESSION_IDS,
            "never",
            NO_AUTO_ARCHIVE_NOW_MS
          )
        : null,
    [session]
  );

  const handleOpen = useCallback(
    () => onOpen(sessionId, session?.name ?? fallbackTitle),
    [fallbackTitle, onOpen, session?.name, sessionId]
  );

  // `sessionsAtom` is not the complete sidebar roster: paginated and fetched
  // child rows can be dragged before they enter that atom. The stable id is
  // still a valid navigation target, so lack of live enrichment must not turn
  // a sidebar-created reference into a false "unavailable" card.
  if (!session || !task) {
    return (
      <ChannelReferenceCard
        testId={CARD_TEST_ID}
        identity={{
          "data-session-id": sessionId,
          "data-session-snapshot": "true",
        }}
        ariaLabel={t("cloud.channels.feed.sessionCardOpen", {
          name: fallbackTitle,
        })}
        onOpen={handleOpen}
      >
        <ChannelReferenceCardTitle
          icon={renderAgentIcon(undefined)}
          title={fallbackTitle}
        />
      </ChannelReferenceCard>
    );
  }

  const inProgress = isSessionInProgress(session.status, session);
  const pendingAsking = isSessionPendingAsking(session);
  const roundCount = turnOverview?.turnCount ?? 0;

  return (
    <ChannelReferenceCard
      testId={CARD_TEST_ID}
      identity={{ "data-session-id": sessionId }}
      ariaLabel={t("cloud.channels.feed.sessionCardOpen", {
        name: task.title,
      })}
      onOpen={handleOpen}
    >
      <ChannelReferenceCardTitle
        icon={renderAgentIcon(task.agentIconId ?? task.cliAgentType)}
        title={task.title}
        trailing={
          inProgress && !pendingAsking
            ? renderBreathingStatusDot()
            : renderStatusDot(
                resolveSessionStatusDotTone(session, visitedSessions)
              )
        }
      />
      <ChannelReferenceCardMeta>
        {task.modelName ? (
          <ChannelReferenceCardMetaItem>
            {formatModelNameFull(task.modelName)}
          </ChannelReferenceCardMetaItem>
        ) : null}
        {roundCount > 0 ? (
          <ChannelReferenceCardMetaItem
            icon={<Repeat size={11} strokeWidth={1.75} aria-hidden />}
          >
            {t("sessions:history.detail.roundCount", { count: roundCount })}
          </ChannelReferenceCardMetaItem>
        ) : null}
        {task.workspaceName ? (
          <ChannelReferenceCardMetaItem
            icon={<FolderGit2 size={11} strokeWidth={1.75} aria-hidden />}
          >
            {task.workspaceName}
          </ChannelReferenceCardMetaItem>
        ) : null}
      </ChannelReferenceCardMeta>
    </ChannelReferenceCard>
  );
};

export default ChannelSessionCard;
