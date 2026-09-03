import { useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AGENT_ORG_RUN_PHASE,
  AGENT_ORG_TASK_STATUS,
  type AgentOrgRunView,
  type AgentOrgTask,
  type AgentOrgTaskExecutionHandoffReceipt,
  type AgentOrgTaskExecutionHandoffResolution,
  type AgentOrgTaskPage,
  type AgentOrgTaskStatus,
  archiveAgentOrgRun,
  deleteAgentOrgTeam,
  getAgentOrgTaskPage,
  pauseAgentOrgRun,
  requestAgentOrgTaskHandoff,
  resolveAgentOrgTaskHandoff,
  resumeAgentOrgRun,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import { AgentOrgWriterBadge } from "@src/engines/ChatPanel/blocks/OrgTaskBadges";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { removeForkRelayEntry } from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  Activity01Icon,
  Alert01Icon,
  ArchiveIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  Delete02Icon,
  HierarchyCircle01Icon,
  HugeiconsIcon,
  InboxIcon,
  PauseIcon,
  PlayIcon,
  Refresh04Icon,
  UserCircleIcon,
  WorkHistoryIcon,
} from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";
import { applyRustSessionDeleteReceipt } from "@src/scaffold/NavigationSidebar/connectors/rustSessionDeleteReceipt";
import { closeSessionChatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { activeSessionIdAtom, removeSession } from "@src/store/session";
import {
  clearPendingFileOpensForSession,
  disposeWorkstationWorkspaceAtom,
} from "@src/store/workstation/tabs";
import { clearPendingCodeEditorTabForSession } from "@src/store/workstation/tabs/pendingCodeEditorTab";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import AgentOrgFinalSummaryCard from "./AgentOrgFinalSummaryCard";
import AgentOrgPlanApprovalCard from "./AgentOrgPlanApprovalCard";
import { AgentOrgTaskList } from "./AgentOrgTaskList";
import ComposerStackHeader, {
  ComposerStackHeaderCountBadge,
} from "./ComposerStackHeader";

const logger = createLogger("AgentOrgOverviewPanel");

// Keep the opposite control disabled briefly after Pause/Resume settles. The
// two controls occupy the same toolbar position, so the second click of a
// double-click can otherwise land on the newly rendered inverse action.
const PAUSE_TOGGLE_GESTURE_COOLDOWN_MS = 500;

const AGENT_SESSION_STATUS = {
  RUNNING: "running",
  WAITING_FOR_USER: "waiting_for_user",
  WAITING_FOR_FUNDS: "waiting_for_funds",
} as const;

interface TaskActionDialogState {
  task: AgentOrgTask;
  action: "cancel" | "reassign";
}

interface HandoffResolutionDialogState {
  receipt: AgentOrgTaskExecutionHandoffReceipt;
  resolution: AgentOrgTaskExecutionHandoffResolution;
}

interface AgentOrgOverviewPanelProps {
  view: AgentOrgRunView | null;
  error: string | null;
  currentSessionId: string;
  onRefresh: () => Promise<void>;
}

const AgentOrgOverviewPanel: React.FC<AgentOrgOverviewPanelProps> = memo(
  ({ view, error, currentSessionId, onRefresh }) => {
    const { t } = useTranslation("sessions");
    const [expanded, setExpanded] = useState(true);
    const [isTogglingPause, setIsTogglingPause] = useState(false);
    const [isArchiving, setIsArchiving] = useState(false);
    const [deleteModalOpen, setDeleteModalOpen] = useState(false);
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [taskActionDialog, setTaskActionDialog] =
      useState<TaskActionDialogState | null>(null);
    const [selectedReplacementOwner, setSelectedReplacementOwner] =
      useState("");
    const [handoffResolutionDialog, setHandoffResolutionDialog] =
      useState<HandoffResolutionDialogState | null>(null);
    const [isMutatingTask, setIsMutatingTask] = useState(false);
    const [historyExpanded, setHistoryExpanded] = useState(false);
    const [historyStatus, setHistoryStatus] = useState<AgentOrgTaskStatus>(
      AGENT_ORG_TASK_STATUS.COMPLETED
    );
    const [historyPage, setHistoryPage] = useState<AgentOrgTaskPage | null>(
      null
    );
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyError, setHistoryError] = useState(false);
    const pauseToggleLockedRef = useRef(false);
    const pauseToggleCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(
      null
    );
    const mountedRef = useRef(true);
    const historyRequestIdRef = useRef(0);
    const currentSessionIdRef = useRef(currentSessionId);
    const currentRunId = view?.context.runId ?? null;
    const currentRunIdRef = useRef(currentRunId);
    currentSessionIdRef.current = currentSessionId;
    currentRunIdRef.current = currentRunId;

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (pauseToggleCooldownRef.current !== null) {
          clearTimeout(pauseToggleCooldownRef.current);
          pauseToggleCooldownRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      const archived = view?.runStatus === "archived";
      historyRequestIdRef.current += 1;
      setHistoryExpanded(archived);
      setHistoryStatus(
        archived
          ? AGENT_ORG_TASK_STATUS.CANCELLED
          : AGENT_ORG_TASK_STATUS.COMPLETED
      );
      setHistoryPage(null);
      setHistoryLoading(false);
      setHistoryError(false);
      setDeleteModalOpen(false);
      setDeleteConfirmed(false);
      setTaskActionDialog(null);
      setHandoffResolutionDialog(null);
      setSelectedReplacementOwner("");
    }, [currentRunId, currentSessionId, view?.runStatus]);
    const handleRefresh = useCallback(() => onRefresh(), [onRefresh]);
    const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
      handleRefresh,
      false
    );
    const setActiveSessionId = useSetAtom(activeSessionIdAtom);
    const { goToNewSession } = useAppNavigation();
    const disposeWorkstationWorkspace = useSetAtom(
      disposeWorkstationWorkspaceAtom
    );
    const closeSessionChatPanelTabs = useSetAtom(closeSessionChatPanelTabsAtom);

    const openTaskAction = useCallback(
      (task: AgentOrgTask, action: "cancel" | "reassign") => {
        setTaskActionDialog({ task, action });
        setSelectedReplacementOwner(
          task.owner ?? view?.context.members[0]?.memberId ?? ""
        );
      },
      [view?.context.members]
    );

    const handleTaskAction = useCallback(async () => {
      if (!taskActionDialog || isMutatingTask) return;
      if (taskActionDialog.action === "reassign" && !selectedReplacementOwner) {
        return;
      }
      setIsMutatingTask(true);
      try {
        await requestAgentOrgTaskHandoff({
          sessionId: currentSessionId,
          requestId: crypto.randomUUID(),
          taskId: taskActionDialog.task.id,
          action: taskActionDialog.action,
          replacementOwnerMemberId:
            taskActionDialog.action === "reassign"
              ? selectedReplacementOwner
              : null,
        });
        setTaskActionDialog(null);
        await onRefresh();
      } catch (taskError) {
        logger.error("Failed to update Agent Team Task:", taskError);
        Message.error(
          t("planner.agentOrgTasks.handoffFailed", {
            defaultValue: "Could not safely update this Task",
          })
        );
      } finally {
        setIsMutatingTask(false);
      }
    }, [
      currentSessionId,
      isMutatingTask,
      onRefresh,
      selectedReplacementOwner,
      t,
      taskActionDialog,
    ]);

    const handleHandoffResolution = useCallback(async () => {
      if (!handoffResolutionDialog || isMutatingTask) return;
      setIsMutatingTask(true);
      try {
        await resolveAgentOrgTaskHandoff({
          sessionId: currentSessionId,
          requestId: crypto.randomUUID(),
          receiptId: handoffResolutionDialog.receipt.id,
          resolution: handoffResolutionDialog.resolution,
        });
        setHandoffResolutionDialog(null);
        await onRefresh();
      } catch (resolutionError) {
        logger.error(
          "Failed to resolve Agent Team Task handoff:",
          resolutionError
        );
        Message.error(
          t("planner.agentOrgTasks.handoffResolutionFailed", {
            defaultValue: "Could not resolve this handoff",
          })
        );
      } finally {
        setIsMutatingTask(false);
      }
    }, [
      currentSessionId,
      handoffResolutionDialog,
      isMutatingTask,
      onRefresh,
      t,
    ]);

    const loadHistoryPage = useCallback(
      async (
        status: AgentOrgTaskStatus,
        cursor?: string | null,
        direction: "forward" | "backward" = "forward"
      ) => {
        const sessionId = currentSessionId;
        const runId = currentRunId;
        const requestId = ++historyRequestIdRef.current;
        setHistoryLoading(true);
        setHistoryError(false);
        setHistoryPage(null);
        try {
          const page = await getAgentOrgTaskPage({
            sessionId,
            bucket: "history",
            status,
            cursor,
            direction,
          });
          if (
            historyRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId
          ) {
            setHistoryPage(page);
          }
        } catch (historyLoadError) {
          logger.error(
            "Failed to load Agent Team Task history:",
            historyLoadError
          );
          if (
            historyRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId
          ) {
            setHistoryError(true);
          }
        } finally {
          if (
            historyRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId
          ) {
            setHistoryLoading(false);
          }
        }
      },
      [currentRunId, currentSessionId]
    );

    const handleHistoryToggle = useCallback(() => {
      const next = !historyExpanded;
      setHistoryExpanded(next);
      if (next && historyPage === null && !historyLoading) {
        void loadHistoryPage(historyStatus);
      }
    }, [
      historyExpanded,
      historyLoading,
      historyPage,
      historyStatus,
      loadHistoryPage,
    ]);

    const handleHistoryStatus = useCallback(
      (status: AgentOrgTaskStatus) => {
        setHistoryStatus(status);
        void loadHistoryPage(status);
      },
      [loadHistoryPage]
    );

    const isRunning = view?.runStatus === "running";
    const isPaused = view?.runStatus === "paused";
    const isArchived = view?.runStatus === "archived";
    const canArchive =
      view?.runStatus === "running" ||
      view?.runStatus === "paused" ||
      view?.runStatus === "idle" ||
      view?.runStatus === "failed";
    const runPhaseLabel = view
      ? view.completion?.state === "certified"
        ? t(`planner.agentOrgOverview.outcome.${view.completion.outcome}`, {
            defaultValue: view.completion.outcome ?? "certified",
          })
        : view.completion?.state === "needs_attention"
          ? t("planner.agentOrgOverview.needsAttention", {
              defaultValue: "Needs attention",
            })
          : t(`planner.agentOrgOverview.phase.${view.runPhase}`, {
              defaultValue: view.runPhase.split("_").join(" "),
            })
      : null;
    const completionBadgeClass =
      view?.completion?.state === "certified"
        ? view.completion.outcome === "delivered"
          ? "bg-success-6/10 text-success-6"
          : view.completion.outcome === "failed"
            ? "bg-error-6/10 text-error-6"
            : "bg-warning-6/10 text-warning-6"
        : view?.completion?.state === "needs_attention"
          ? "bg-warning-6/10 text-warning-6"
          : "bg-bg-1 text-text-2";
    const coordinatorWorkStateLabel = view
      ? t(
          `planner.agentOrgOverview.coordinatorWorkState.${view.coordinatorWorkState}`,
          {
            defaultValue: view.coordinatorWorkState.split("_").join(" "),
          }
        )
      : null;

    const rootSessionId = view?.context.rootSessionId;
    const isViewingCoordinatorSession =
      rootSessionId != null && currentSessionId === rootSessionId;
    const canNavigateToCoordinator =
      rootSessionId != null && !isViewingCoordinatorSession;

    const handleNavigateToCoordinator = useCallback(() => {
      if (rootSessionId) {
        setActiveSessionId(rootSessionId);
      }
    }, [rootSessionId, setActiveSessionId]);

    const beginPauseToggle = useCallback(() => {
      if (pauseToggleLockedRef.current) return false;
      pauseToggleLockedRef.current = true;
      setIsTogglingPause(true);
      return true;
    }, []);

    const finishPauseToggle = useCallback(() => {
      if (!mountedRef.current) {
        pauseToggleLockedRef.current = false;
        return;
      }
      pauseToggleCooldownRef.current = setTimeout(() => {
        pauseToggleCooldownRef.current = null;
        pauseToggleLockedRef.current = false;
        setIsTogglingPause(false);
      }, PAUSE_TOGGLE_GESTURE_COOLDOWN_MS);
    }, []);

    const handlePauseRun = useCallback(async () => {
      if (!currentSessionId || !beginPauseToggle()) return;
      try {
        await pauseAgentOrgRun(currentSessionId);
        await onRefresh();
      } catch (err: unknown) {
        logger.error("Failed to pause Agent Team run:", err);
      } finally {
        finishPauseToggle();
      }
    }, [beginPauseToggle, currentSessionId, finishPauseToggle, onRefresh]);

    const handleResumeRun = useCallback(async () => {
      if (!currentSessionId || !beginPauseToggle()) return;
      try {
        await resumeAgentOrgRun(currentSessionId);
        await onRefresh();
      } catch (err: unknown) {
        logger.error("Failed to resume Agent Team run:", err);
      } finally {
        finishPauseToggle();
      }
    }, [beginPauseToggle, currentSessionId, finishPauseToggle, onRefresh]);

    const handleArchiveRun = useCallback(async () => {
      if (!currentSessionId || !canArchive || isArchiving) return;
      const confirmed = await confirmDestructiveAction({
        title: t("planner.agentOrgOverview.archiveTitle", {
          defaultValue: "Archive this Team?",
        }),
        message: isRunning
          ? t("planner.agentOrgOverview.archiveWorkingWarning", {
              defaultValue:
                "Archive is permanent. Tasks currently being executed will be cancelled, and the Team will become read-only.",
            })
          : t("planner.agentOrgOverview.archiveWarning", {
              defaultValue:
                "Archive is permanent. The Team will become read-only and cannot be resumed.",
            }),
        okLabel: t("planner.agentOrgOverview.archiveRun", {
          defaultValue: "Archive",
        }),
        cancelLabel: t("common:actions.cancel"),
      });
      if (!confirmed) return;
      setIsArchiving(true);
      try {
        await archiveAgentOrgRun(currentSessionId);
        await onRefresh();
      } catch (archiveError) {
        logger.error("Failed to Archive Agent Team:", archiveError);
        Message.error(
          t("planner.agentOrgOverview.archiveFailed", {
            defaultValue: "Failed to Archive Team",
          })
        );
      } finally {
        setIsArchiving(false);
      }
    }, [canArchive, currentSessionId, isArchiving, isRunning, onRefresh, t]);

    const closeDeleteModal = useCallback(() => {
      if (isDeleting) return;
      setDeleteModalOpen(false);
      setDeleteConfirmed(false);
    }, [isDeleting]);

    const handleDeleteTeam = useCallback(async () => {
      if (!currentSessionId || !isArchived || !deleteConfirmed || isDeleting)
        return;
      setIsDeleting(true);
      try {
        const receipt = await deleteAgentOrgTeam(currentSessionId);
        const cleanup = {
          removeSession,
          removeForkRelayEntry,
          disposeWorkstationWorkspace,
          clearPendingFileOpens: clearPendingFileOpensForSession,
          clearPendingCodeEditorTab: clearPendingCodeEditorTabForSession,
          evictEventStore: (deletedSessionId: string) =>
            eventStoreProxy.evictSession(deletedSessionId),
        };
        const requiresNavigationReset = await applyRustSessionDeleteReceipt({
          requestedSessionId: currentSessionId,
          activeSessionId: currentSessionId,
          isAgentOrgRoot: view?.context.rootSessionId === currentSessionId,
          receipt,
          cleanup: {
            ...cleanup,
            closeSessionTabs: closeSessionChatPanelTabs,
          },
        });
        cleanup.removeSession(currentSessionId);
        cleanup.removeForkRelayEntry(currentSessionId);
        cleanup.disposeWorkstationWorkspace(currentSessionId);
        cleanup.clearPendingFileOpens(currentSessionId);
        cleanup.clearPendingCodeEditorTab(currentSessionId);
        setDeleteModalOpen(false);
        // Closing the active Team tab already activates one safe neighbour (or
        // Launchpad). Only reset navigation when the deleted session had no
        // Chat Panel tab to own that transition, such as a WorkStation-only
        // presentation.
        if (requiresNavigationReset) goToNewSession();
      } catch (deleteError) {
        logger.error("Failed to delete Archived Agent Team:", deleteError);
        Message.error(
          t("planner.agentOrgOverview.deleteFailed", {
            defaultValue: "Failed to delete Team",
          })
        );
      } finally {
        setIsDeleting(false);
      }
    }, [
      currentSessionId,
      closeSessionChatPanelTabs,
      deleteConfirmed,
      disposeWorkstationWorkspace,
      goToNewSession,
      isArchived,
      isDeleting,
      t,
      view?.context.rootSessionId,
    ]);

    useEffect(() => {
      if (
        isArchived &&
        historyExpanded &&
        historyPage === null &&
        !historyLoading &&
        !historyError
      ) {
        void loadHistoryPage(AGENT_ORG_TASK_STATUS.CANCELLED);
      }
    }, [
      historyExpanded,
      historyError,
      historyLoading,
      historyPage,
      isArchived,
      loadHistoryPage,
    ]);

    if (!view && !error) return null;

    const completedTasks = view?.taskOverview.completed ?? 0;
    const totalTasks = view?.taskOverview.total ?? 0;
    const activeMembers =
      view?.members.filter(
        (member) =>
          member.sessionRuntime?.status === AGENT_SESSION_STATUS.RUNNING ||
          member.sessionRuntime?.status ===
            AGENT_SESSION_STATUS.WAITING_FOR_USER ||
          member.sessionRuntime?.status ===
            AGENT_SESSION_STATUS.WAITING_FOR_FUNDS ||
          member.activity != null
      ).length ?? 0;
    const membersWithDirectActivity =
      view?.members.filter((member) => member.activity != null) ?? [];
    const unreadMessages = view?.unreadInboxCount ?? 0;
    const planRevisions = view?.planRevisions ?? [];
    const activeHandoffs = (view?.executionHandoffs ?? []).filter(
      (receipt) => receipt.resolution == null && receipt.state !== "released"
    );
    const canManageTasks =
      view?.context.rootSessionId === currentSessionId && isRunning;

    const badges = error ? (
      <span className="text-error-6 ml-1 inline-flex items-center gap-1 text-[13px] font-medium">
        <HugeiconsIcon
          icon={CancelCircleIcon}
          data-icon="xcircle"
          size={11}
          strokeWidth={2}
        />
        {t("planner.agentOrgOverview.loadFailed")}
      </span>
    ) : (
      <div className="flex items-center gap-1">
        {runPhaseLabel && (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium capitalize ${completionBadgeClass}`}
            data-testid="agent-org-overview-run-phase"
            data-run-phase={view?.runPhase ?? ""}
            data-completion-state={view?.completion?.state ?? "none"}
            data-completion-outcome={view?.completion?.outcome ?? ""}
          >
            {(view?.runPhase === AGENT_ORG_RUN_PHASE.FINALIZING ||
              view?.runPhase === AGENT_ORG_RUN_PHASE.DRAINING) && (
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                size={9}
                strokeWidth={2}
                className="mr-1 inline-block animate-spin motion-reduce:animate-none"
              />
            )}
            {runPhaseLabel}
          </span>
        )}
        {coordinatorWorkStateLabel && (
          <span
            className="rounded-full bg-bg-1 px-1.5 py-0.5 text-[10px] font-medium text-text-3"
            data-testid="agent-org-coordinator-work-state"
            data-coordinator-work-state={
              view?.coordinatorWorkState ?? "inactive"
            }
          >
            {coordinatorWorkStateLabel}
          </span>
        )}
        <ComposerStackHeaderCountBadge>
          {t("planner.agentOrgOverview.summary", {
            active: activeMembers,
            unread: unreadMessages,
          })}
        </ComposerStackHeaderCountBadge>
      </div>
    );

    return (
      <div
        data-testid="agent-org-overview-panel"
        data-agent-org-overview-panel="true"
        data-run-id={view?.context.runId ?? ""}
        data-run-phase={view?.runPhase ?? ""}
        className="min-w-0"
      >
        <ComposerStackHeader
          label={view?.context.orgName ?? t("planner.agentOrgOverview.title")}
          icon={
            <HugeiconsIcon
              icon={HierarchyCircle01Icon}
              data-icon="network"
              size={13}
              strokeWidth={1.75}
              className="text-text-3"
            />
          }
          expanded={expanded}
          onToggle={() => setExpanded((previous) => !previous)}
          badges={badges}
          actions={
            <div className="flex items-center gap-0.5">
              {canNavigateToCoordinator && (
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="mini"
                  iconOnly
                  aria-label={t(
                    "planner.agentOrgOverview.viewCoordinatorHistory"
                  )}
                  title={t("planner.agentOrgOverview.viewCoordinatorHistory")}
                  onClick={handleNavigateToCoordinator}
                  data-testid="agent-org-overview-coordinator-history-button"
                  icon={
                    <HugeiconsIcon
                      icon={WorkHistoryIcon}
                      data-icon="history"
                      size={11}
                      strokeWidth={2}
                    />
                  }
                />
              )}
              {isRunning && (
                <Button
                  htmlType="button"
                  variant="secondary"
                  size="mini"
                  iconOnly
                  disabled={isTogglingPause}
                  aria-label={t("planner.agentOrgOverview.pauseRun")}
                  title={t("planner.agentOrgOverview.pauseRun")}
                  onClick={handlePauseRun}
                  data-testid="agent-org-overview-pause-button"
                  icon={
                    <HugeiconsIcon
                      icon={PauseIcon}
                      data-icon="pause"
                      size={11}
                      strokeWidth={2}
                    />
                  }
                />
              )}
              {isPaused && (
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="mini"
                  iconOnly
                  disabled={isTogglingPause}
                  aria-label={t("planner.agentOrgOverview.resumeRun")}
                  title={t("planner.agentOrgOverview.resumeRun")}
                  onClick={handleResumeRun}
                  data-testid="agent-org-overview-resume-button"
                  icon={
                    <HugeiconsIcon
                      icon={PlayIcon}
                      data-icon="play"
                      size={11}
                      strokeWidth={2}
                    />
                  }
                />
              )}
              {canArchive && (
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="mini"
                  iconOnly
                  disabled={isArchiving || isTogglingPause}
                  aria-label={t("planner.agentOrgOverview.archiveRun", {
                    defaultValue: "Archive Team",
                  })}
                  title={t("planner.agentOrgOverview.archiveRun", {
                    defaultValue: "Archive Team",
                  })}
                  onClick={() => void handleArchiveRun()}
                  data-testid="agent-org-overview-archive-button"
                  icon={
                    <HugeiconsIcon
                      icon={ArchiveIcon}
                      data-icon="archive"
                      size={11}
                      strokeWidth={2}
                    />
                  }
                />
              )}
              <Button
                htmlType="button"
                variant="tertiary"
                size="mini"
                iconOnly
                aria-label={t("common:actions.refresh")}
                title={t("common:actions.refresh")}
                onClick={handleRefreshClick}
                data-testid="agent-org-overview-refresh-button"
                icon={
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    data-icon="refresh-cw"
                    size={12}
                    strokeWidth={2}
                    className={spinClass}
                  />
                }
              />
            </div>
          }
        />

        {expanded && view && (
          <div
            className="space-y-2 px-2 pb-2"
            data-testid="agent-org-overview-body"
          >
            <div className="grid grid-cols-3 gap-1.5 text-[11px] text-text-3">
              <div className="rounded-md bg-bg-1 px-2 py-1.5">
                <div className="flex items-center gap-1 text-text-2">
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    data-icon="check-circle-2"
                    size={11}
                    strokeWidth={2}
                  />
                  {t("planner.agentOrgOverview.tasks")}
                </div>
                <div className="mt-0.5 font-medium text-text-1">
                  {t("planner.agentOrgOverview.doneOf", {
                    done: completedTasks,
                    total: totalTasks,
                  })}
                </div>
              </div>
              <div className="rounded-md bg-bg-1 px-2 py-1.5">
                <div className="flex items-center gap-1 text-text-2">
                  <HugeiconsIcon
                    icon={UserCircleIcon}
                    data-icon="user-round"
                    size={11}
                    strokeWidth={2}
                  />
                  {t("planner.agentOrgOverview.members")}
                </div>
                <div className="mt-0.5 font-medium text-text-1">
                  {t("planner.agentOrgOverview.activeOf", {
                    active: activeMembers,
                    total: view.members.length,
                  })}
                </div>
              </div>
              <div className="rounded-md bg-bg-1 px-2 py-1.5">
                <div className="flex items-center gap-1 text-text-2">
                  <HugeiconsIcon
                    icon={InboxIcon}
                    data-icon="inbox"
                    size={11}
                    strokeWidth={2}
                  />
                  {t("planner.agentOrgOverview.inbox")}
                </div>
                <div className="mt-0.5 font-medium text-text-1">
                  {t("planner.agentOrgOverview.unreadCount", {
                    count: unreadMessages,
                  })}
                </div>
              </div>
            </div>

            {view.finalSummary?.status === "failed" ? (
              <AgentOrgFinalSummaryCard
                receipt={view.finalSummary}
                sessionId={currentSessionId}
                onRetried={onRefresh}
              />
            ) : null}

            {planRevisions.length > 0 ? (
              <div className="space-y-2" data-testid="agent-org-plan-approvals">
                <div className="px-1 text-[11px] font-medium text-text-2">
                  {t("planner.agentOrgOverview.planApproval.historyTitle", {
                    defaultValue: "Plan history",
                  })}
                </div>
                {planRevisions.map((approval) => (
                  <AgentOrgPlanApprovalCard
                    key={approval.approvalId}
                    approval={approval}
                    sourceMemberName={
                      view.members.find(
                        (member) => member.memberId === approval.sourceMemberId
                      )?.name ?? approval.sourceMemberId
                    }
                    sessionId={currentSessionId}
                    disabled={!isRunning}
                    onResolved={onRefresh}
                  />
                ))}
              </div>
            ) : null}

            {membersWithDirectActivity.length > 0 && (
              <div
                className="space-y-1"
                data-testid="agent-org-overview-member-activity"
              >
                <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-medium text-text-2">
                  <HugeiconsIcon
                    icon={Activity01Icon}
                    data-icon="activity"
                    size={11}
                    strokeWidth={2}
                  />
                  <span>{t("planner.agentOrgOverview.directActivity")}</span>
                </div>
                {membersWithDirectActivity.map((member) => (
                  <div
                    key={`${member.memberId}:${member.activity?.interventionReceiptId}`}
                    className="flex min-w-0 items-center gap-2 rounded-md bg-bg-1 px-2 py-1.5 text-[11px]"
                    data-testid={`agent-org-overview-member-activity-${member.memberId}`}
                    data-activity-kind={member.activity?.kind}
                    data-activity-source={member.activity?.source}
                    data-intervention-receipt-id={
                      member.activity?.interventionReceiptId
                    }
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-text-1">
                      {member.name}
                    </span>
                    {member.writerCapable && !member.isCoordinator && (
                      <AgentOrgWriterBadge>
                        {t("planner.agentOrgIntervention.writerBadge")}
                      </AgentOrgWriterBadge>
                    )}
                    <span className="shrink-0 text-text-3">
                      {t(
                        `planner.agentOrgIntervention.activity.${member.activity?.kind}`,
                        { count: member.queuedUserDirectedCount }
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1" data-testid="agent-org-overview-tasks">
              <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-medium text-text-2">
                <HugeiconsIcon
                  icon={CheckmarkCircle01Icon}
                  data-icon="check-circle-2"
                  size={11}
                  strokeWidth={2}
                />
                <span className="min-w-0 flex-1 truncate">
                  {t("planner.agentOrgTasks.currentWork")}
                </span>
              </div>
              {activeHandoffs.map((receipt) => {
                const resolvable =
                  receipt.state === "timeout" ||
                  receipt.state === "unknown" ||
                  receipt.state === "failed";
                return (
                  <div
                    key={receipt.id}
                    className="space-y-2 rounded-md border border-warning-6/30 bg-warning-6/5 px-2 py-2 text-[10px] text-text-2"
                    data-testid="agent-org-task-handoff-status"
                    data-handoff-state={receipt.state}
                  >
                    <div className="flex items-center gap-1 font-medium text-warning-6">
                      <HugeiconsIcon
                        icon={Alert01Icon}
                        data-icon="alert"
                        size={11}
                        strokeWidth={2}
                      />
                      {resolvable
                        ? t("planner.agentOrgTasks.handoffNeedsDecision", {
                            defaultValue: "Task handoff needs your decision",
                          })
                        : t("planner.agentOrgTasks.handoffStopping", {
                            defaultValue: "Stopping the previous execution",
                          })}
                    </div>
                    <div className="break-all text-text-3">
                      {t("planner.agentOrgTasks.handoffEvidence", {
                        owner: receipt.oldOwnerMemberId,
                        state: receipt.state,
                        count: receipt.localEffectCount,
                        defaultValue:
                          "Previous owner: {{owner}} · {{state}} · local writers: {{count}}",
                      })}
                    </div>
                    {resolvable && canManageTasks && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="mini"
                          variant="secondary"
                          disabled={receipt.localEffectCount !== 0}
                          onClick={() =>
                            setHandoffResolutionDialog({
                              receipt,
                              resolution: "continue_replacement",
                            })
                          }
                          data-testid="agent-org-handoff-continue-button"
                        >
                          {t("planner.agentOrgTasks.continueReplacement", {
                            defaultValue: "Continue replacement",
                          })}
                        </Button>
                        <Button
                          size="mini"
                          variant="tertiary"
                          onClick={() =>
                            setHandoffResolutionDialog({
                              receipt,
                              resolution: "keep_stopped",
                            })
                          }
                          data-testid="agent-org-handoff-keep-stopped-button"
                        >
                          {t("planner.agentOrgTasks.keepStopped", {
                            defaultValue: "Keep stopped",
                          })}
                        </Button>
                        <Button
                          size="mini"
                          variant="danger"
                          onClick={() =>
                            setHandoffResolutionDialog({
                              receipt,
                              resolution: "abandon_episode",
                            })
                          }
                          data-testid="agent-org-handoff-abandon-button"
                        >
                          {t("planner.agentOrgTasks.abandonEpisode", {
                            defaultValue: "Abandon episode",
                          })}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
              {view.tasks.length > 0 ? (
                <AgentOrgTaskList
                  tasks={view.tasks}
                  awaitingApprovalTaskIds={planRevisions
                    .filter((revision) => revision.status === "pending")
                    .map((revision) => revision.sourceTaskId)}
                  listTestId="agent-org-overview-task-list"
                  rowTestId="agent-org-overview-task-row"
                  className="px-0 pb-0"
                  currentSessionId={currentSessionId}
                  currentRunId={view.context.runId}
                  canManageTasks={canManageTasks}
                  onTaskAction={openTaskAction}
                />
              ) : (
                <div className="px-1 py-2 text-[10px] text-text-3">
                  {t("planner.agentOrgTasks.currentEmpty")}
                </div>
              )}
              {view.taskOverview.truncated && (
                <div
                  className="px-1 text-[10px] text-text-3"
                  data-testid="agent-org-overview-task-window-note"
                >
                  {t("planner.agentOrgOverview.taskWindowTruncated", {
                    visible: view.taskOverview.visible,
                    total:
                      view.taskOverview.pending + view.taskOverview.inProgress,
                  })}
                </div>
              )}
            </div>

            <div className="space-y-2" data-testid="agent-org-task-history">
              <button
                type="button"
                className="flex w-full items-center gap-1 px-1 text-left text-[11px] font-medium text-text-2 hover:text-text-1 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none"
                aria-expanded={historyExpanded}
                onClick={handleHistoryToggle}
                data-testid="agent-org-task-history-toggle"
              >
                <HugeiconsIcon
                  icon={historyExpanded ? ArrowDown01Icon : ArrowRight01Icon}
                  data-icon={historyExpanded ? "chevron-down" : "chevron-right"}
                  size={11}
                  strokeWidth={2}
                />
                <span className="min-w-0 flex-1">
                  {t("planner.agentOrgTasks.history")}
                </span>
                <span className="text-[10px] text-text-3">
                  {view.taskOverview.completed +
                    view.taskOverview.failed +
                    view.taskOverview.cancelled}
                </span>
              </button>

              {historyExpanded && (
                <div className="space-y-2">
                  <div
                    className="flex flex-wrap gap-1 px-1"
                    role="group"
                    aria-label={t("planner.agentOrgTasks.historyFilter")}
                  >
                    {(
                      [
                        AGENT_ORG_TASK_STATUS.COMPLETED,
                        AGENT_ORG_TASK_STATUS.FAILED,
                        AGENT_ORG_TASK_STATUS.CANCELLED,
                      ] as const
                    ).map((status) => (
                      <button
                        key={status}
                        type="button"
                        className={`rounded-full px-2 py-0.5 text-[10px] focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none ${historyStatus === status ? "bg-primary-6/10 text-primary-6" : "bg-bg-1 text-text-3"}`}
                        aria-pressed={historyStatus === status}
                        onClick={() => handleHistoryStatus(status)}
                        data-testid={`agent-org-task-history-filter-${status}`}
                      >
                        {t(
                          status === AGENT_ORG_TASK_STATUS.COMPLETED
                            ? "planner.agentOrgTasks.statusCompleted"
                            : status === AGENT_ORG_TASK_STATUS.FAILED
                              ? "planner.agentOrgTasks.statusFailed"
                              : "planner.agentOrgTasks.statusCancelled"
                        )}
                      </button>
                    ))}
                  </div>
                  {historyLoading && (
                    <div className="px-1 text-[10px] text-text-3" role="status">
                      {t("planner.agentOrgTasks.loadingHistory")}
                    </div>
                  )}
                  {historyError && (
                    <div className="text-error-6 px-1 text-[10px]" role="alert">
                      {t("planner.agentOrgTasks.historyLoadFailed")}
                    </div>
                  )}
                  {!historyLoading && historyPage?.tasks.length === 0 && (
                    <div className="px-1 py-2 text-[10px] text-text-3">
                      {t("planner.agentOrgTasks.historyEmpty")}
                    </div>
                  )}
                  {historyPage && historyPage.tasks.length > 0 && (
                    <AgentOrgTaskList
                      tasks={historyPage.tasks}
                      listTestId="agent-org-task-history-list"
                      rowTestId="agent-org-task-history-row"
                      className="px-0 pb-0"
                      currentSessionId={currentSessionId}
                      currentRunId={view.context.runId}
                    />
                  )}
                  {historyPage &&
                    (historyPage.previousCursor || historyPage.nextCursor) && (
                      <div className="flex items-center justify-end gap-1 px-1">
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] text-text-2 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none disabled:opacity-40"
                          data-testid="agent-org-task-history-previous-page"
                          disabled={
                            !historyPage.previousCursor || historyLoading
                          }
                          onClick={() =>
                            void loadHistoryPage(
                              historyStatus,
                              historyPage.previousCursor,
                              "backward"
                            )
                          }
                        >
                          {t("planner.agentOrgTasks.previousPage")}
                        </button>
                        <button
                          type="button"
                          className="rounded px-2 py-1 text-[10px] text-text-2 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none disabled:opacity-40"
                          data-testid="agent-org-task-history-next-page"
                          disabled={!historyPage.nextCursor || historyLoading}
                          onClick={() =>
                            void loadHistoryPage(
                              historyStatus,
                              historyPage.nextCursor,
                              "forward"
                            )
                          }
                        >
                          {t("planner.agentOrgTasks.nextPage")}
                        </button>
                      </div>
                    )}
                </div>
              )}
            </div>

            {isArchived && view.archiveTeardown && (
              <div
                className="rounded-md bg-bg-1 px-2 py-2 text-[11px] text-text-3"
                data-testid="agent-org-archive-teardown-status"
                data-teardown-status={view.archiveTeardown.status}
              >
                {view.archiveTeardown.status === "pending"
                  ? t("planner.agentOrgOverview.archiveTeardownPending", {
                      defaultValue:
                        "Archived. Runtime shutdown is still finishing in the background.",
                    })
                  : view.archiveTeardown.status === "retained_runtime"
                    ? t("planner.agentOrgOverview.archiveTeardownRetained", {
                        count: view.archiveTeardown.retainedRuntimeCount,
                        defaultValue:
                          "Archived, but {{count}} runtime could not be released. Delete remains blocked.",
                      })
                    : t("planner.agentOrgOverview.archiveTeardownQuiesced", {
                        defaultValue:
                          "Archived and fully stopped. Permanent deletion is now available.",
                      })}
              </div>
            )}

            {isArchived && (
              <div
                className="border-error-6/20 space-y-2 rounded-md border px-2 py-2"
                data-testid="agent-org-danger-zone"
              >
                <div className="text-error-6 flex items-center gap-1 text-[11px] font-medium">
                  <HugeiconsIcon
                    icon={Alert01Icon}
                    data-icon="alert-triangle"
                    size={11}
                    strokeWidth={2}
                  />
                  {t("planner.agentOrgOverview.dangerZone", {
                    defaultValue: "Danger Zone",
                  })}
                </div>
                <div className="text-[10px] leading-4 text-text-3">
                  {t("planner.agentOrgOverview.deleteDescription", {
                    defaultValue:
                      "Permanently delete this Team and all of its sessions and history.",
                  })}
                </div>
                <Button
                  htmlType="button"
                  variant="danger"
                  size="mini"
                  disabled={view.archiveTeardown?.status !== "quiesced"}
                  onClick={() => setDeleteModalOpen(true)}
                  data-testid="agent-org-overview-delete-button"
                  icon={
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      data-icon="trash-2"
                      size={11}
                      strokeWidth={2}
                    />
                  }
                >
                  {t("planner.agentOrgOverview.deleteTeam", {
                    defaultValue: "Delete Team",
                  })}
                </Button>
              </div>
            )}
          </div>
        )}

        <Modal
          visible={taskActionDialog !== null}
          title={
            taskActionDialog?.action === "reassign"
              ? t("planner.agentOrgTasks.reassignTitle", {
                  defaultValue: "Reassign this Task?",
                })
              : t("planner.agentOrgTasks.cancelTitle", {
                  defaultValue: "Cancel this Task?",
                })
          }
          className="agent-org-overview-owned-overlay"
          width={420}
          maskClosable={!isMutatingTask}
          closable={!isMutatingTask}
          onCancel={() => !isMutatingTask && setTaskActionDialog(null)}
          bodyClassName="space-y-3 px-5 py-4"
          footerTopBorder={false}
          footer={
            <div className="flex h-12 items-center justify-end gap-2 px-3">
              <Button
                variant="tertiary"
                disabled={isMutatingTask}
                onClick={() => setTaskActionDialog(null)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant={
                  taskActionDialog?.action === "cancel" ? "danger" : "primary"
                }
                disabled={
                  isMutatingTask ||
                  (taskActionDialog?.action === "reassign" &&
                    !selectedReplacementOwner)
                }
                loading={isMutatingTask}
                onClick={() => void handleTaskAction()}
                data-testid="agent-org-task-handoff-confirm-button"
              >
                {taskActionDialog?.action === "reassign"
                  ? t("planner.agentOrgTasks.reassign", {
                      defaultValue: "Reassign",
                    })
                  : t("planner.agentOrgTasks.cancelTask", {
                      defaultValue: "Cancel Task",
                    })}
              </Button>
            </div>
          }
        >
          <div className="text-[12px] leading-5 text-text-2">
            {taskActionDialog?.action === "reassign"
              ? t("planner.agentOrgTasks.reassignWarning", {
                  defaultValue:
                    "The current execution must stop before the replacement can start.",
                })
              : t("planner.agentOrgTasks.cancelWarning", {
                  defaultValue:
                    "The current execution will be stopped. Other Tasks continue.",
                })}
          </div>
          {taskActionDialog?.action === "reassign" && (
            <div className="space-y-1 text-[11px] text-text-2">
              <div>
                {t("planner.agentOrgTasks.replacementOwner", {
                  defaultValue: "Replacement owner",
                })}
              </div>
              <Select
                value={selectedReplacementOwner}
                disabled={isMutatingTask}
                onChange={(value) => setSelectedReplacementOwner(String(value))}
                options={(view?.context.members ?? []).map((member) => ({
                  value: member.memberId,
                  label: `${member.name} · ${member.role}`,
                  dataTestId: `agent-org-task-reassign-owner-option-${member.memberId}`,
                }))}
                className="w-full"
                panelZIndex={10010}
                placement="auto"
                dataTestId="agent-org-task-reassign-owner-select"
                ariaLabel={t("planner.agentOrgTasks.replacementOwner", {
                  defaultValue: "Replacement owner",
                })}
              />
            </div>
          )}
        </Modal>

        <Modal
          visible={handoffResolutionDialog !== null}
          title={t("planner.agentOrgTasks.resolveHandoffTitle", {
            defaultValue: "Resolve Task handoff?",
          })}
          className="agent-org-overview-owned-overlay"
          width={440}
          maskClosable={!isMutatingTask}
          closable={!isMutatingTask}
          onCancel={() => !isMutatingTask && setHandoffResolutionDialog(null)}
          bodyClassName="space-y-3 px-5 py-4"
          footerTopBorder={false}
          footer={
            <div className="flex h-12 items-center justify-end gap-2 px-3">
              <Button
                variant="tertiary"
                disabled={isMutatingTask}
                onClick={() => setHandoffResolutionDialog(null)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant={
                  handoffResolutionDialog?.resolution === "abandon_episode"
                    ? "danger"
                    : "primary"
                }
                disabled={
                  isMutatingTask ||
                  (handoffResolutionDialog?.resolution ===
                    "continue_replacement" &&
                    handoffResolutionDialog.receipt.localEffectCount !== 0)
                }
                loading={isMutatingTask}
                onClick={() => void handleHandoffResolution()}
                data-testid="agent-org-handoff-resolution-confirm-button"
              >
                {handoffResolutionDialog?.resolution === "continue_replacement"
                  ? t("planner.agentOrgTasks.continueReplacement", {
                      defaultValue: "Continue replacement",
                    })
                  : handoffResolutionDialog?.resolution === "keep_stopped"
                    ? t("planner.agentOrgTasks.keepStopped", {
                        defaultValue: "Keep stopped",
                      })
                    : t("planner.agentOrgTasks.abandonEpisode", {
                        defaultValue: "Abandon episode",
                      })}
              </Button>
            </div>
          }
        >
          <div
            className="rounded-md border border-warning-6/25 bg-warning-6/5 px-3 py-2 text-[12px] leading-5 text-text-2"
            role="alert"
          >
            {handoffResolutionDialog?.resolution === "continue_replacement"
              ? t("planner.agentOrgTasks.continueWarning", {
                  defaultValue:
                    "Continue only after local execution and processes are stopped. Any unknown external result is accepted by this decision.",
                })
              : handoffResolutionDialog?.resolution === "keep_stopped"
                ? t("planner.agentOrgTasks.keepStoppedWarning", {
                    defaultValue:
                      "The replacement will be cancelled. The old Task will not restart, and sibling Tasks continue.",
                  })
                : t("planner.agentOrgTasks.abandonWarning", {
                    defaultValue:
                      "Every open Task in this episode will stop and the Team outcome will be Cancelled.",
                  })}
          </div>
        </Modal>

        <Modal
          visible={deleteModalOpen}
          title={t("planner.agentOrgOverview.deleteTitle", {
            defaultValue: "Permanently delete this Team?",
          })}
          // Modal portals to document.body; keep it inside Overview's
          // document-level outside-click boundary for real pointer events.
          className="agent-org-overview-owned-overlay"
          width={420}
          maskClosable={!isDeleting}
          closable={!isDeleting}
          onCancel={closeDeleteModal}
          bodyClassName="space-y-3 px-5 py-4"
          footerTopBorder={false}
          footer={
            <div className="flex h-12 items-center justify-end gap-2 px-3">
              <Button
                variant="tertiary"
                disabled={isDeleting}
                onClick={closeDeleteModal}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={!deleteConfirmed || isDeleting}
                loading={isDeleting}
                onClick={() => void handleDeleteTeam()}
                data-testid="agent-org-delete-confirm-button"
              >
                {t("planner.agentOrgOverview.deleteTeam", {
                  defaultValue: "Delete Team",
                })}
              </Button>
            </div>
          }
        >
          <div
            className="border-error-6/25 bg-error-6/5 rounded-md border px-3 py-2 text-[12px] leading-5 text-text-2"
            role="alert"
          >
            {t("planner.agentOrgOverview.deleteWarning", {
              defaultValue:
                "This permanently deletes every Team session and its history. This action cannot be undone.",
            })}
          </div>
          <Checkbox
            checked={deleteConfirmed}
            disabled={isDeleting}
            onCheckedChange={setDeleteConfirmed}
          >
            {t("planner.agentOrgOverview.deleteAcknowledge", {
              defaultValue: "I understand this deletion is permanent.",
            })}
          </Checkbox>
        </Modal>
      </div>
    );
  }
);

AgentOrgOverviewPanel.displayName = "AgentOrgOverviewPanel";

export default AgentOrgOverviewPanel;
