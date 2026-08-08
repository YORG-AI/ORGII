import { emit } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import { ListChecks, SquareArrowOutUpRight, Trash2, X } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import {
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { WorkItemThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import { WorkItemDetailHeaderBreadcrumb } from "@src/modules/ProjectManager/WorkItems/components/WorkItemDetail/WorkItemDetailHeader";
import { useWorkItemOrchestrator } from "@src/modules/ProjectManager/WorkItems/hooks";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import { closeWorkItemChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { activeSessionIdAtom } from "@src/store/session";
import {
  type ChatPanelSelectedWorkItem,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { WORK_ITEM_STATUS, type WorkItem } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import SessionContentView from "../SessionContentView";
import { usePendingWorkItemAction } from "./usePendingWorkItemAction";
import { useWorkItemGitHubIssueState } from "./useWorkItemGitHubIssueState";

const logger = createLogger("WorkItemPanelView");
const saveNoPendingWorkItemChanges = async (): Promise<void> => undefined;

interface WorkItemPanelViewProps {
  selectedWorkItem: ChatPanelSelectedWorkItem;
  onUpdateWorkItem?: (updates: Partial<WorkItem>) => void;
  onClose?: () => void;
}

function applyWorkItemPatch(
  workItem: WorkItem,
  updates: Partial<WorkItem>
): WorkItem {
  return {
    ...workItem,
    ...updates,
    updated_time: new Date().toISOString(),
  };
}

export const WorkItemPanelView: React.FC<WorkItemPanelViewProps> = ({
  selectedWorkItem,
  onUpdateWorkItem,
  onClose,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const closeWorkItemTab = useSetAtom(closeWorkItemChatPanelTabAtom);
  const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const [floatingSessionId, setFloatingSessionId] = useState<string | null>(
    null
  );
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);
  const workItemMembers = useMemo(
    () => [
      ...(selectedWorkItem.sourceProject?.project.members ?? []),
      ...(selectedWorkItem.workItem.assignee
        ? [selectedWorkItem.workItem.assignee]
        : []),
    ],
    [
      selectedWorkItem.sourceProject?.project.members,
      selectedWorkItem.workItem.assignee,
    ]
  );
  const { currentUser } = useCurrentUserMemberIds(workItemMembers);
  const sourceProjectSyncAdapterId =
    selectedWorkItem.sourceProject?.project.syncAdapterId;

  useEffect(() => {
    const projectSlug = selectedWorkItem.projectSlug;
    // Navigation already carries the canonical project record. Only fall back
    // to a status IPC for older/restored tab payloads that lack that field.
    if (!projectSlug || sourceProjectSyncAdapterId !== undefined) return;

    let cancelled = false;
    void projectSyncApi
      .status(projectSlug)
      .then((status) => {
        if (!cancelled) {
          setProjectSyncAdapter({
            projectSlug,
            adapterId: status.adapter_id,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectSyncAdapter({ projectSlug, adapterId: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkItem.projectSlug, sourceProjectSyncAdapterId]);

  const handleUpdateWorkItem = useCallback(
    async (updates: Partial<WorkItem>) => {
      if (onUpdateWorkItem) {
        onUpdateWorkItem(updates);
        return;
      }

      try {
        const payload = toWorkItemPartialUpdate(updates, currentUser);
        if (Object.keys(payload).length === 0) return;

        if (selectedWorkItem.projectSlug) {
          const updatedWorkItem = enrichedWorkItemToUI(
            await projectApi.updateWorkItemPartial(
              selectedWorkItem.projectSlug,
              selectedWorkItem.shortId,
              payload
            )
          );
          setSelectedWorkItem({
            ...selectedWorkItem,
            workItem: updatedWorkItem,
          });
        } else {
          const updatedWorkItem = applyWorkItemPatch(
            selectedWorkItem.workItem,
            updates
          );
          // Atomic partial update, kept under the owning org — an orgless
          // whole-row write would re-home a collab-org item to
          // personal-org and detach it from sync, and a client-side merge
          // could silently drop concurrent edits.
          await projectApi.updateStandaloneWorkItemPartial(
            selectedWorkItem.shortId,
            payload,
            selectedWorkItem.orgId
              ? { orgId: selectedWorkItem.orgId }
              : undefined
          );
          setSelectedWorkItem({
            ...selectedWorkItem,
            workItem: updatedWorkItem,
          });
        }
        await emit("orgii-data-changed", {
          project_slug: selectedWorkItem.projectSlug || undefined,
          work_item_id: selectedWorkItem.shortId,
          source: "chat-panel-work-item-update",
        });
      } catch (error) {
        logger.error("Failed to update chat panel work item", error);
      }
    },
    [currentUser, onUpdateWorkItem, selectedWorkItem, setSelectedWorkItem]
  );

  const refreshSelectedWorkItemOnce = useCallback(async () => {
    try {
      if (selectedWorkItem.projectSlug) {
        const fresh = await projectApi.readWorkItemEnriched(
          selectedWorkItem.projectSlug,
          selectedWorkItem.shortId,
          selectedWorkItem.orgId ? { orgId: selectedWorkItem.orgId } : undefined
        );
        if (fresh.deletedAt) {
          // A collaborator may delete the item itself or its parent project
          // while this detail is open. Enriched reads intentionally retain
          // soft-deleted rows, so a tombstone must be treated as absent too;
          // otherwise the sidebar disappears while an editable ghost remains.
          closeWorkItemTab(selectedWorkItem.shortId);
          return;
        }
        setSelectedWorkItem((current) =>
          current?.projectSlug === selectedWorkItem.projectSlug &&
          current.shortId === selectedWorkItem.shortId &&
          current.orgId === selectedWorkItem.orgId
            ? { ...current, workItem: enrichedWorkItemToUI(fresh) }
            : current
        );
        return;
      }
      if (!selectedWorkItem.shortId) return;
      const data = await projectApi.readStandaloneWorkItem(
        selectedWorkItem.shortId,
        selectedWorkItem.orgId ? { orgId: selectedWorkItem.orgId } : undefined
      );
      setSelectedWorkItem((current) =>
        current?.shortId === selectedWorkItem.shortId &&
        current.orgId === selectedWorkItem.orgId
          ? {
              ...current,
              workItem: enrichedWorkItemToUI(
                standaloneWorkItemDataToEnriched(data)
              ),
            }
          : current
      );
    } catch (error) {
      if (String(error).toLowerCase().includes("not found")) {
        // The single-item command resolves both the parent and item at the
        // authoritative SQLite boundary. Either tombstone makes this cached
        // tab invalid, without scanning every project and every work item.
        closeWorkItemTab(selectedWorkItem.shortId);
        return;
      }
      logger.warn("Failed to refresh chat panel work item", error);
    }
  }, [closeWorkItemTab, selectedWorkItem, setSelectedWorkItem]);

  const refreshOnceRef = useRef(refreshSelectedWorkItemOnce);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  useEffect(() => {
    refreshOnceRef.current = refreshSelectedWorkItemOnce;
  }, [refreshSelectedWorkItemOnce]);

  const refreshSelectedWorkItem = useCallback((): Promise<void> => {
    if (refreshInFlightRef.current) {
      return refreshInFlightRef.current;
    }

    const request = refreshOnceRef.current().finally(() => {
      if (refreshInFlightRef.current === request) {
        refreshInFlightRef.current = null;
      }
    });
    refreshInFlightRef.current = request;
    return request;
  }, []);

  useProjectDataChanged(
    useCallback(
      (change) => {
        if (
          change?.projectSlug &&
          change.projectSlug !== selectedWorkItem.projectSlug
        ) {
          return;
        }
        if (
          change?.workItemId &&
          change.workItemId !== selectedWorkItem.shortId
        ) {
          return;
        }
        void refreshSelectedWorkItem();
      },
      [
        refreshSelectedWorkItem,
        selectedWorkItem.projectSlug,
        selectedWorkItem.shortId,
      ]
    ),
    // A detail surface can mount from a cached navigation payload after the
    // mutation signal already fired. Refreshing on mount closes that race;
    // subsequent signals keep the open panel live.
    { fireOnMount: true }
  );

  // The chat-panel detail is a second presentation of the same Work Item,
  // not a read-only workflow mock. Reuse the canonical orchestrator hook so
  // agent actions, cloud execution locks, and lock-holder labels behave the
  // same here as they do in the full Project Manager detail.
  const repoPath =
    selectedWorkItem.sourceProject?.project.linkedRepos?.[0]?.id ??
    activeWorkspaceRootPath ??
    null;
  const {
    isStartingAgent,
    activeAgentSessionId,
    activeAgentRole,
    handleStartAgent,
    handleRetry,
    handleCancelAgent,
    handleAcceptAsIs,
    handleCreateFollowUp,
    isLockedByOther,
    lockHolderName,
  } = useWorkItemOrchestrator({
    workItem: selectedWorkItem.workItem,
    displayWorkItem: selectedWorkItem.workItem,
    repoPath,
    projectSlug: selectedWorkItem.projectSlug,
    shortId: selectedWorkItem.shortId,
    onRefreshWorkItem: refreshSelectedWorkItem,
    onUpdateWorkItem: handleUpdateWorkItem,
    hasPendingChanges: false,
    handleSave: saveNoPendingWorkItemChanges,
  });

  usePendingWorkItemAction({
    workItemShortId: selectedWorkItem.shortId,
    onStartAgent: handleStartAgent,
  });

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      setFloatingSessionId(sessionId);
      setActiveSessionId(sessionId);
    },
    [setActiveSessionId]
  );

  const handleCloseFloatingSession = useCallback(() => {
    setFloatingSessionId(null);
  }, []);

  const linkedSessions = useMemo(
    () => selectedWorkItem.workItem.linkedSessions ?? [],
    [selectedWorkItem.workItem.linkedSessions]
  );
  const floatingSession = useMemo(
    () =>
      floatingSessionId
        ? linkedSessions.find(
            (session) => session.session_id === floatingSessionId
          )
        : undefined,
    [floatingSessionId, linkedSessions]
  );

  const workItemContentKey = `${selectedWorkItem.projectSlug}:${
    selectedWorkItem.shortId || selectedWorkItem.workItem.session_id
  }`;
  const projectSyncAdapterId =
    sourceProjectSyncAdapterId ??
    (projectSyncAdapter?.projectSlug === selectedWorkItem.projectSlug
      ? projectSyncAdapter.adapterId
      : undefined);
  const isGitHubSyncedProject =
    projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB;
  const selectedWorkItemStatus =
    selectedWorkItem.workItem.workItemStatus ??
    selectedWorkItem.workItem.status;
  const isGitHubWorkItem =
    isGitHubSyncedProject ||
    selectedWorkItemStatus === WORK_ITEM_STATUS.GITHUB_OPEN ||
    selectedWorkItemStatus === WORK_ITEM_STATUS.GITHUB_CLOSED;
  const githubIssueState = useWorkItemGitHubIssueState({
    enabled: isGitHubWorkItem,
    repoPath,
    shortId: selectedWorkItem.shortId,
    stateScopeKey: `chat-panel-work-item:${selectedWorkItem.orgId ?? "local"}:${selectedWorkItem.projectSlug}:${selectedWorkItem.shortId}`,
  });
  const projectSelectionReadonly =
    Boolean(selectedWorkItem.projectSlug) &&
    (projectSyncAdapterId === undefined || isGitHubSyncedProject);
  const handleDeleteWorkItem = useCallback(async () => {
    if (!selectedWorkItem.projectSlug) return;

    const confirmed = await confirmDestructiveAction({
      title: t("common:actions.confirmDeleteTitle", {
        name: selectedWorkItem.workItem.name,
      }),
      message: t("common:actions.confirmDeleteMessage"),
      okLabel: t("common:actions.delete"),
      cancelLabel: t("common:actions.cancel"),
    });
    if (!confirmed) return;

    try {
      await projectApi.deleteWorkItem(
        selectedWorkItem.projectSlug,
        selectedWorkItem.shortId
      );
      // The tab payload owns this surface. Clearing only the legacy selection
      // mirror leaves the deleted detail mounted until another data-change
      // refresh happens, and a later cascade can fall back to that ghost tab.
      closeWorkItemTab(selectedWorkItem.shortId);
      await emit("orgii-data-changed", {
        project_slug: selectedWorkItem.projectSlug,
        work_item_id: selectedWorkItem.shortId,
        source: "chat-panel-work-item-delete",
      });
    } catch (error) {
      logger.error("Failed to delete chat panel work item", error);
    }
  }, [closeWorkItemTab, selectedWorkItem, t]);

  const headerActions = useMemo(
    () =>
      selectedWorkItem.projectSlug &&
      projectSyncAdapterId !== undefined &&
      !isGitHubSyncedProject ? (
        <div className="flex items-center gap-px">
          <WorkstationToolbarTooltip
            label={t("projects:workItems.deleteWorkItem")}
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={() => void handleDeleteWorkItem()}
              aria-label={t("projects:workItems.deleteWorkItem")}
              data-testid="work-item-delete"
              icon={<Trash2 size={HEADER_ICON_SIZE.sm} />}
            />
          </WorkstationToolbarTooltip>
        </div>
      ) : null,
    [
      handleDeleteWorkItem,
      isGitHubSyncedProject,
      projectSyncAdapterId,
      selectedWorkItem.projectSlug,
      t,
    ]
  );

  const headerContent = useMemo(
    () => (
      <WorkItemDetailHeaderBreadcrumb
        workItem={selectedWorkItem.workItem}
        breadcrumbProjectName={selectedWorkItem.projectName}
        breadcrumbIcon={
          isGitHubSyncedProject ? (
            <IntegrationIcon
              type={STORY_SYNC_ADAPTER.GITHUB}
              size={HEADER_ICON_SIZE.sm}
            />
          ) : (
            <ListChecks size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          )
        }
        shortId={selectedWorkItem.shortId}
        onClose={onClose}
        onTitleChange={
          !isGitHubWorkItem &&
          (!selectedWorkItem.projectSlug || projectSyncAdapterId !== undefined)
            ? (title) => void handleUpdateWorkItem({ name: title })
            : undefined
        }
        t={t}
      />
    ),
    [
      selectedWorkItem.projectName,
      selectedWorkItem.shortId,
      selectedWorkItem.workItem,
      selectedWorkItem.projectSlug,
      isGitHubSyncedProject,
      isGitHubWorkItem,
      projectSyncAdapterId,
      handleUpdateWorkItem,
      onClose,
      t,
    ]
  );

  usePublishChatPanelHeader({
    content: { content: headerContent, trailing: headerActions },
  });

  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-work-item-detail"
    >
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkItemThreadSurface
          key={workItemContentKey}
          workItem={selectedWorkItem.workItem}
          propertyProps={{
            onUpdate: handleUpdateWorkItem,
            availableProjects: selectedWorkItem.workItem.project
              ? [selectedWorkItem.workItem.project]
              : [],
            availableMilestones: selectedWorkItem.workItem.milestone
              ? [selectedWorkItem.workItem.milestone]
              : [],
            availableLabels: selectedWorkItem.workItem.labels ?? [],
            availableMembers: workItemMembers,
            projectIconType: isGitHubSyncedProject
              ? STORY_SYNC_ADAPTER.GITHUB
              : undefined,
            projectReadonly: projectSelectionReadonly,
          }}
          onUpdateWorkItem={handleUpdateWorkItem}
          onUpdateWorkItemImmediate={handleUpdateWorkItem}
          currentUser={currentUser ?? undefined}
          teamMembers={workItemMembers}
          repoPath={repoPath}
          projectSlug={selectedWorkItem.projectSlug}
          shortId={selectedWorkItem.shortId}
          githubIssueTimeline={githubIssueState.timeline}
          githubIssueInteraction={githubIssueState.interaction}
          onStartAgent={handleStartAgent}
          isStartingAgent={isStartingAgent}
          onCancelAgent={handleCancelAgent}
          onRetry={handleRetry}
          onAcceptAsIs={handleAcceptAsIs}
          onCreateFollowUp={handleCreateFollowUp}
          onOpenSession={handleOpenSession}
          onRefreshWorkflow={refreshSelectedWorkItem}
          activeAgentSessionId={activeAgentSessionId}
          activeAgentRole={activeAgentRole}
          isLockedByOther={isLockedByOther}
          lockHolderName={lockHolderName}
        />
      </div>
      {floatingSessionId && (
        <div
          className="absolute inset-x-3 bottom-3 top-16 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border-1 bg-chat-pane shadow-2xl"
          data-testid="work-item-floating-session-chat"
          data-session-id={floatingSessionId}
        >
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border-1 bg-bg-1/95 px-3 backdrop-blur">
            <div className="flex min-w-0 items-center gap-2">
              <SquareArrowOutUpRight
                size={14}
                className="shrink-0 text-text-3"
              />
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-text-1">
                  {floatingSession?.result_preview ||
                    floatingSession?.sub_agent_name ||
                    floatingSession?.agent_role ||
                    t("common:terminology.session")}
                </div>
                <div className="truncate text-[11px] text-text-4">
                  {floatingSession?.status
                    ? `${floatingSession.status} · ${floatingSession.session_type}`
                    : floatingSessionId}
                </div>
              </div>
            </div>
            <Button
              variant="tertiary"
              appearance="ghost"
              shape="circle"
              size="small"
              onClick={handleCloseFloatingSession}
              aria-label="Close linked session chat"
              data-testid="work-item-floating-session-chat-close"
              icon={<X size={15} />}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <SessionContentView
              sessionId={floatingSessionId}
              secondary
              surfaceBgClass="bg-chat-pane"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkItemPanelView;
