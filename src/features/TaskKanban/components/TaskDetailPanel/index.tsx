/**
 * TaskDetailPanel
 *
 * Right pane of the Kanban view. Two layouts:
 *
 *   1. Session-bearing tasks (the common case): a compact header
 *      strip with title + status + worktree actions, and the
 *      session's `ChatView` filling the body. Lets the user inspect
 *      and steer the run without leaving the kanban surface.
 *
 *   2. Tasks with no `session_id` (rare metadata-only rows): the
 *      legacy detail layout — title, description, tags, status.
 *
 * # Pipeline / WorkStation independence
 *
 * `<ChatView>`'s mount effect writes the pipeline atom
 * (`activeSessionIdAtom`) but NOT the WorkStation memory atom
 * (`workstationActiveSessionIdAtom`). So showing session B here
 * doesn't change what WorkStation will show next time it becomes
 * visible — WorkStation re-asserts its own memory via the bridge
 * effect in `modules/index.tsx`. See `viewAtom.ts` for the full
 * two-atom model.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import SessionContentView from "@src/engines/ChatPanel/SessionContentView";
import { useChatEventReplay } from "@src/engines/ChatPanel/hooks/useChatEventReplay";
import { sortedEventsAtom } from "@src/engines/SessionCore/core/atoms";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { sessionMapAtom } from "@src/store/session";
import { chatTurnPaginationEnabledAtom } from "@src/store/ui/chatPanelAtom";
import { simulatorSessionPlaybackPlayingAtom } from "@src/store/ui/simulatorAtom";

import type { KanbanTask } from "../../types";
import TaskDetailHeader from "./TaskDetailHeader";
import type { TaskDetailNavigationDirection } from "./TaskDetailHeader";
import TaskDetailHeaderActions from "./TaskDetailHeaderActions";
import TaskDetailInfoSection from "./TaskDetailInfoSection";
import TaskDetailViewPill from "./TaskDetailViewPill";
import type { TaskDetailView } from "./TaskDetailViewPill";
import TouchedFilesList from "./TouchedFilesList";
import {
  type MergeStrategy,
  buildDiscardConfirmationMessage,
  getMergeFailureMessage,
  isDirtyRepoMergeError,
  isMergeRetryStatus,
  isMergeSettledStatus,
} from "./helpers";
import "./index.scss";

export interface TaskDetailPanelProps {
  visible: boolean;
  task: KanbanTask | null;
  onClose: () => void;
  onNavigate?: (direction: TaskDetailNavigationDirection) => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

const TaskDetailPanel: React.FC<TaskDetailPanelProps> = ({
  visible,
  task,
  onClose,
  onNavigate,
  hasPrev = false,
  hasNext = false,
}) => {
  if (!visible) return null;

  if (!task) {
    return <Placeholder variant="loading" placement="detail-panel" />;
  }

  return task.session_id ? (
    <SessionTaskPanel
      task={task}
      sessionId={task.session_id}
      onClose={onClose}
      onNavigate={onNavigate}
      hasPrev={hasPrev}
      hasNext={hasNext}
    />
  ) : (
    <MetadataTaskPanel
      task={task}
      onClose={onClose}
      onNavigate={onNavigate}
      hasPrev={hasPrev}
      hasNext={hasNext}
    />
  );
};

interface SessionTaskPanelProps extends Omit<
  TaskDetailPanelProps,
  "visible" | "task"
> {
  task: KanbanTask;
  sessionId: string;
}

const SessionTaskPanel: React.FC<SessionTaskPanelProps> = ({
  task,
  sessionId,
  onClose,
  onNavigate,
  hasPrev,
  hasNext,
}) => {
  const { t } = useTranslation("sessions");
  const sessionMap = useAtomValue(sessionMapAtom);
  const session = sessionMap.get(sessionId);
  const { replayEventById, canReplay } = useChatEventReplay();
  const setSessionPlaybackPlaying = useSetAtom(
    simulatorSessionPlaybackPlayingAtom
  );
  const turnPaginationEnabled = useAtomValue(chatTurnPaginationEnabledAtom);
  const sortedEvents = useAtomValue(sortedEventsAtom);

  const [detailView, setDetailView] = useState<TaskDetailView>("trajectory");
  const touchedFiles = session?.touchedFiles ?? [];

  const [mergeLoading, setMergeLoading] = useState(false);
  const [discardLoading, setDiscardLoading] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>("auto");
  const [strategyOpen, setStrategyOpen] = useState(false);
  const strategyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!strategyOpen) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (strategyRef.current && !strategyRef.current.contains(target)) {
        setStrategyOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [strategyOpen]);

  const mergeStatus = session?.mergeStatus;
  const isSettled = isMergeSettledStatus(mergeStatus);
  const hasWorktree = session?.worktreeBranch != null && !isSettled;
  const isCompleted = session?.status === "completed";
  const canMerge = hasWorktree && isCompleted;
  const isRetryState = isMergeRetryStatus(mergeStatus);

  const handleMerge = useCallback(async () => {
    setMergeLoading(true);
    setMergeError(null);
    try {
      const result = await SessionService.merge({
        sessionId,
        strategy: mergeStrategy,
      });
      if (!result.merged) {
        setMergeError(getMergeFailureMessage(result, t));
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      setMergeError(
        isDirtyRepoMergeError(rawMessage)
          ? t("kanban.merge.dirtyRepo")
          : rawMessage
      );
    } finally {
      setMergeLoading(false);
    }
  }, [sessionId, mergeStrategy, t]);

  const handleDiscard = useCallback(async () => {
    const confirmed = window.confirm(buildDiscardConfirmationMessage(t));
    if (!confirmed) return;
    setDiscardLoading(true);
    try {
      await SessionService.worktreeDiscard(sessionId);
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : String(error));
    } finally {
      setDiscardLoading(false);
    }
  }, [sessionId, t]);

  const handleReplay = useCallback(() => {
    if (!canReplay) return;
    const firstEventId = sortedEvents[0]?.id;
    if (!firstEventId) return;
    replayEventById(firstEventId);
    setSessionPlaybackPlaying(true);
  }, [canReplay, sortedEvents, replayEventById, setSessionPlaybackPlaying]);

  const handleToggleStrategy = useCallback(() => {
    setStrategyOpen((open) => !open);
  }, []);

  const handleSelectStrategy = useCallback((strategy: MergeStrategy) => {
    setMergeStrategy(strategy);
    setStrategyOpen(false);
  }, []);

  const mergeButtonTitle = isRetryState
    ? t("kanban.merge.retryMerge")
    : t("common:actions.confirm");

  return (
    <div className="task-detail-panel">
      <TaskDetailHeader
        title={task.title}
        onClose={onClose}
        onNavigate={onNavigate}
        hasPrev={hasPrev}
        hasNext={hasNext}
        actions={
          <div className="flex items-center gap-1.5">
            <TaskDetailViewPill
              activeView={detailView}
              onChange={setDetailView}
            />
            <TaskDetailHeaderActions
              canReplay={canReplay}
              canMerge={canMerge}
              mergeLoading={mergeLoading}
              discardLoading={discardLoading}
              strategyOpen={strategyOpen}
              mergeStrategy={mergeStrategy}
              mergeButtonTitle={mergeButtonTitle}
              strategyRef={strategyRef}
              t={t}
              onReplay={handleReplay}
              onMerge={handleMerge}
              onDiscard={handleDiscard}
              onToggleStrategy={handleToggleStrategy}
              onSelectStrategy={handleSelectStrategy}
            />
          </div>
        }
      />

      {mergeError && (
        <div className="task-detail-panel__error-strip">{mergeError}</div>
      )}

      <div className="task-detail-panel__chat">
        <div
          className="h-full"
          style={detailView === "touched" ? { display: "none" } : undefined}
        >
          <SessionContentView
            key={sessionId}
            sessionId={sessionId}
            secondary
            turnPaginationEnabled={turnPaginationEnabled}
          />
        </div>
        {detailView === "touched" && <TouchedFilesList files={touchedFiles} />}
      </div>
    </div>
  );
};

interface MetadataTaskPanelProps extends Omit<TaskDetailPanelProps, "visible"> {
  task: KanbanTask;
}

const MetadataTaskPanel: React.FC<MetadataTaskPanelProps> = ({
  task,
  onClose,
  onNavigate,
  hasPrev,
  hasNext,
}) => (
  <div className="task-detail-panel">
    <TaskDetailHeader
      title={task.title}
      onClose={onClose}
      onNavigate={onNavigate}
      hasPrev={hasPrev}
      hasNext={hasNext}
    />

    <TaskDetailInfoSection task={task} />
  </div>
);

export default TaskDetailPanel;
