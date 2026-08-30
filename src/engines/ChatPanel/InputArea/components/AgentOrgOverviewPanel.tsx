import { useSetAtom } from "jotai";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AGENT_ORG_RUN_PHASE,
  type AgentOrgRunView,
  pauseAgentOrgRun,
  resumeAgentOrgRun,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { createLogger } from "@src/hooks/logger";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  HierarchyCircle01Icon,
  HugeiconsIcon,
  InboxIcon,
  PauseIcon,
  PlayIcon,
  Refresh04Icon,
  UserCircleIcon,
  WorkHistoryIcon,
} from "@src/icons";
import { activeSessionIdAtom } from "@src/store/session";

import AgentOrgPlanApprovalCard from "./AgentOrgPlanApprovalCard";
import { AgentOrgTaskList } from "./AgentOrgTaskList";
import ComposerStackHeader, {
  ComposerStackHeaderCountBadge,
} from "./ComposerStackHeader";

const logger = createLogger("AgentOrgOverviewPanel");

const AGENT_SESSION_STATUS = {
  RUNNING: "running",
  WAITING_FOR_USER: "waiting_for_user",
  WAITING_FOR_FUNDS: "waiting_for_funds",
} as const;

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
    const handleRefresh = useCallback(() => onRefresh(), [onRefresh]);
    const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
      handleRefresh,
      false
    );
    const setActiveSessionId = useSetAtom(activeSessionIdAtom);

    const isRunning = view?.runStatus === "running";
    const isPaused = view?.runStatus === "paused";
    const runPhaseLabel = view
      ? t(`planner.agentOrgOverview.phase.${view.runPhase}`, {
          defaultValue: view.runPhase.split("_").join(" "),
        })
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

    const handlePauseRun = useCallback(async () => {
      if (!currentSessionId || isTogglingPause) return;
      setIsTogglingPause(true);
      try {
        await pauseAgentOrgRun(currentSessionId);
        await onRefresh();
      } catch (err: unknown) {
        logger.error("Failed to pause Agent Team run:", err);
      } finally {
        setIsTogglingPause(false);
      }
    }, [currentSessionId, isTogglingPause, onRefresh]);

    const handleResumeRun = useCallback(async () => {
      if (!currentSessionId || isTogglingPause) return;
      setIsTogglingPause(true);
      try {
        await resumeAgentOrgRun(currentSessionId);
        await onRefresh();
      } catch (err: unknown) {
        logger.error("Failed to resume Agent Team run:", err);
      } finally {
        setIsTogglingPause(false);
      }
    }, [currentSessionId, isTogglingPause, onRefresh]);

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
            AGENT_SESSION_STATUS.WAITING_FOR_FUNDS
      ).length ?? 0;
    const unreadMessages = view?.unreadInboxCount ?? 0;
    const userPlanApprovals =
      view?.pendingPlanApprovals.filter(
        (approval) =>
          approval.policy === "user" && approval.status === "pending"
      ) ?? [];

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
            className="rounded-full bg-bg-1 px-1.5 py-0.5 text-[10px] font-medium capitalize text-text-2"
            data-testid="agent-org-overview-run-phase"
            data-run-phase={view?.runPhase ?? ""}
          >
            {view?.runPhase === AGENT_ORG_RUN_PHASE.FINALIZING && (
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

            {userPlanApprovals.length > 0 ? (
              <div className="space-y-2" data-testid="agent-org-plan-approvals">
                <div className="px-1 text-[11px] font-medium text-text-2">
                  {t("planner.agentOrgOverview.planApproval.title")}
                </div>
                {userPlanApprovals.map((approval) => (
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

            {view.tasks.length > 0 && (
              <div className="space-y-1" data-testid="agent-org-overview-tasks">
                <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-medium text-text-2">
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    data-icon="check-circle-2"
                    size={11}
                    strokeWidth={2}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {t("planner.agentOrgTasks.title")}
                  </span>
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
                        size={10}
                        strokeWidth={2}
                        className={spinClass}
                      />
                    }
                  />
                </div>
                <AgentOrgTaskList
                  tasks={view.tasks}
                  listTestId="agent-org-overview-task-list"
                  rowTestId="agent-org-overview-task-row"
                  className="px-0 pb-0"
                  currentSessionId={currentSessionId}
                />
                {view.taskOverview.truncated && (
                  <div
                    className="px-1 text-[10px] text-text-3"
                    data-testid="agent-org-overview-task-window-note"
                  >
                    {t("planner.agentOrgOverview.taskWindowTruncated", {
                      visible: view.taskOverview.visible,
                      total: view.taskOverview.total,
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

AgentOrgOverviewPanel.displayName = "AgentOrgOverviewPanel";

export default AgentOrgOverviewPanel;
