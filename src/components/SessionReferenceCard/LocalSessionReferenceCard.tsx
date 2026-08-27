import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
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
  ReferenceCard,
  ReferenceCardMeta,
  ReferenceCardMetaItem,
  ReferenceCardTitle,
} from "./ReferenceCard";

const NO_SESSION_IDS: ReadonlySet<string> = new Set<string>();
const NO_AUTO_ARCHIVE_NOW_MS = 0;

export interface LocalSessionReferenceCardProps {
  sessionId: string;
  fallbackTitle: string;
  onOpen: (sessionId: string, fallbackTitle?: string) => void;
  testId?: string;
}

function renderAgentIcon(iconId: string | undefined) {
  const AgentIcon = resolveAgentIcon(iconId);
  return <AgentIcon size={12} strokeWidth={1.75} />;
}

const LocalSessionReferenceCard: React.FC<LocalSessionReferenceCardProps> = ({
  sessionId,
  fallbackTitle,
  onOpen,
  testId = "session-reference-card",
}) => {
  const { t } = useTranslation("navigation");
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const visitedForSessionAtom = useMemo(
    () => selectAtom(visitedSessionsAtom, (visited) => visited.has(sessionId)),
    [sessionId]
  );
  const visited = useAtomValue(visitedForSessionAtom);
  const visitedSessions = useMemo<ReadonlySet<string>>(
    () => (visited ? new Set([sessionId]) : NO_SESSION_IDS),
    [sessionId, visited]
  );
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
  const title = task?.title || session?.name || fallbackTitle;
  const handleOpen = useCallback(
    () => onOpen(sessionId, title),
    [onOpen, sessionId, title]
  );

  if (!session || !task) {
    return (
      <ReferenceCard
        testId={testId}
        identity={{
          "data-session-id": sessionId,
          "data-session-snapshot": "true",
        }}
        ariaLabel={t("cloud.channels.feed.sessionCardOpen", { name: title })}
        onOpen={handleOpen}
      >
        <ReferenceCardTitle icon={renderAgentIcon(undefined)} title={title} />
      </ReferenceCard>
    );
  }

  const inProgress = isSessionInProgress(session.status, session);
  const pendingAsking = isSessionPendingAsking(session);
  const roundCount = turnOverview?.turnCount ?? 0;

  return (
    <ReferenceCard
      testId={testId}
      identity={{ "data-session-id": sessionId }}
      ariaLabel={t("cloud.channels.feed.sessionCardOpen", { name: title })}
      onOpen={handleOpen}
    >
      <ReferenceCardTitle
        icon={renderAgentIcon(task.agentIconId ?? task.cliAgentType)}
        title={title}
        trailing={
          inProgress && !pendingAsking
            ? renderBreathingStatusDot()
            : renderStatusDot(
                resolveSessionStatusDotTone(session, visitedSessions)
              )
        }
      />
      <ReferenceCardMeta>
        {task.modelName ? (
          <ReferenceCardMetaItem>
            {formatModelNameFull(task.modelName)}
          </ReferenceCardMetaItem>
        ) : null}
        {roundCount > 0 ? (
          <ReferenceCardMetaItem
            icon={<Repeat size={11} strokeWidth={1.75} aria-hidden />}
          >
            {t("sessions:history.detail.roundCount", { count: roundCount })}
          </ReferenceCardMetaItem>
        ) : null}
        {task.workspaceName ? (
          <ReferenceCardMetaItem
            icon={<FolderGit2 size={11} strokeWidth={1.75} aria-hidden />}
          >
            {task.workspaceName}
          </ReferenceCardMetaItem>
        ) : null}
      </ReferenceCardMeta>
    </ReferenceCard>
  );
};

export default LocalSessionReferenceCard;
