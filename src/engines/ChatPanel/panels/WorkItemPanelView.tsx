import { emit } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import { ExternalLink, Trash2, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type WorkItemFrontmatter,
  type WorkItemPartialUpdate,
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  ChatPanelHeaderBreadcrumb,
  usePublishChatPanelHeader,
} from "@src/engines/ChatPanel/header";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import {
  WorkItemContent,
  WorkItemProperties,
} from "@src/modules/ProjectManager/WorkItems/components";
import { WORK_ITEM_PROPERTY_INLINE_FIELDS } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties";
import { useWorkItemOrchestrator } from "@src/modules/ProjectManager/WorkItems/hooks";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import { activeSessionIdAtom } from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSelectedWorkItem,
  chatPanelNavigateAtom,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import {
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
} from "@src/store/workstation";
import type { WorkItem } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import ChatView from "../ChatView";

const logger = createLogger("WorkItemPanelView");
const saveNoPendingWorkItemChanges = async (): Promise<void> => undefined;

interface WorkItemPanelViewProps {
  selectedWorkItem: ChatPanelSelectedWorkItem;
  onUpdateWorkItem?: (updates: Partial<WorkItem>) => void;
}

function toStandaloneFrontmatter(
  workItem: WorkItem,
  shortId: string
): WorkItemFrontmatter {
  const now = new Date().toISOString();
  return {
    id: shortId,
    short_id: shortId,
    title: workItem.name,
    project: workItem.project?.id,
    status: workItem.workItemStatus ?? workItem.status ?? "backlog",
    priority: workItem.priority ?? "none",
    assignee: workItem.assignee?.id,
    assignee_type: workItem.assigneeType,
    labels: workItem.labels?.map((label) => label.id) ?? [],
    milestone: workItem.milestone?.id,
    start_date: workItem.startDate,
    target_date: workItem.endDate ?? workItem.target_date ?? undefined,
    created_at: workItem.created_time || now,
    updated_at: now,
    starred: workItem.star ?? false,
    todos:
      workItem.todos?.map((todo) => ({
        id: todo.id,
        content: todo.content,
        status: todo.status,
      })) ?? [],
    comments: workItem.comments,
    linked_sessions: workItem.linkedSessions,
    proof_of_work: workItem.proofOfWork,
    orchestrator_config: workItem.orchestratorConfig,
    orchestrator_state: workItem.orchestratorState,
    schedule: workItem.schedule ?? undefined,
    routine_source: workItem.routineSource,
    execution_lock: workItem.executionLock,
    close_out: workItem.closeOut,
    work_products: workItem.workProducts,
  };
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

function toWorkItemPartialUpdate(
  updates: Partial<WorkItem>
): WorkItemPartialUpdate {
  const payload: WorkItemPartialUpdate = {};

  if (updates.name !== undefined) payload.title = updates.name;
  if (updates.spec !== undefined) payload.body = updates.spec;
  if (updates.workItemStatus !== undefined) {
    payload.status = updates.workItemStatus;
  }
  if (updates.priority !== undefined) payload.priority = updates.priority;
  if (updates.project?.id) payload.project = updates.project.id;
  if (updates.star !== undefined) payload.starred = updates.star;
  if ("assignee" in updates) payload.assignee = updates.assignee?.id ?? null;
  if ("assigneeType" in updates) {
    payload.assigneeType = updates.assigneeType ?? null;
  }
  if ("labels" in updates) {
    payload.labels = updates.labels?.map((label) => label.id) ?? [];
  }
  if ("milestone" in updates) {
    payload.milestone = updates.milestone?.id ?? null;
  }
  if ("startDate" in updates) payload.startDate = updates.startDate ?? null;
  if ("endDate" in updates) payload.targetDate = updates.endDate ?? null;
  if ("target_date" in updates) {
    payload.targetDate = updates.target_date ?? null;
  }
  if (updates.todos !== undefined) {
    payload.todos = updates.todos.map((todo) => ({
      id: todo.id,
      content: todo.content,
      status: todo.status,
    }));
  }
  if (updates.comments !== undefined) {
    payload.comments = updates.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: comment.content,
      created_at: comment.created_at,
    }));
  }
  if (updates.linkedSessions !== undefined) {
    payload.linkedSessions = updates.linkedSessions;
  }
  if (updates.orchestratorConfig !== undefined) {
    payload.orchestratorConfig = updates.orchestratorConfig;
  }
  if (updates.orchestratorState !== undefined) {
    payload.orchestratorState = updates.orchestratorState;
  }
  if (updates.schedule !== undefined) payload.schedule = updates.schedule;
  if (updates.executionLock !== undefined) {
    payload.executionLock = updates.executionLock;
  }
  if (updates.closeOut !== undefined) payload.closeOut = updates.closeOut;
  if (updates.workProducts !== undefined) {
    payload.workProducts = updates.workProducts;
  }

  return payload;
}

export const WorkItemPanelView: React.FC<WorkItemPanelViewProps> = ({
  selectedWorkItem,
  onUpdateWorkItem,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const setSelectedWorkItem = useSetAtom(chatPanelSelectedWorkItemAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const [floatingSessionId, setFloatingSessionId] = useState<string | null>(
    null
  );

  const handleUpdateWorkItem = useCallback(
    async (updates: Partial<WorkItem>) => {
      if (onUpdateWorkItem) {
        onUpdateWorkItem(updates);
        return;
      }

      try {
        const payload = toWorkItemPartialUpdate(updates);
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
          // Keep the item under its owning org — the Rust upsert
          // overwrites org_id on conflict, so an orgless write would
          // re-home a collab-org item to personal-org and detach it
          // from sync.
          await projectApi.writeStandaloneWorkItem(
            selectedWorkItem.shortId,
            toStandaloneFrontmatter(updatedWorkItem, selectedWorkItem.shortId),
            updatedWorkItem.spec ?? "",
            selectedWorkItem.orgId
              ? { orgId: selectedWorkItem.orgId }
              : undefined
          );
          setSelectedWorkItem({
            ...selectedWorkItem,
            workItem: updatedWorkItem,
          });
        }
        await emit("orgii-data-changed");
      } catch (error) {
        logger.error("Failed to update chat panel work item", error);
      }
    },
    [onUpdateWorkItem, selectedWorkItem, setSelectedWorkItem]
  );

  const refreshSelectedWorkItem = useCallback(async () => {
    try {
      if (selectedWorkItem.projectSlug) {
        const projects = await projectApi.readProjects();
        const projectStillExists = projects.some(
          (project) => project.slug === selectedWorkItem.projectSlug
        );
        if (!projectStillExists) {
          // Reading the deleted project's items throws before it can return an
          // empty list, so detect the parent tombstone explicitly. The local
          // project store is authoritative even when cloud transport is down.
          setSelectedWorkItem(null);
          return;
        }
        const items = await projectApi.readWorkItemsEnriched(
          selectedWorkItem.projectSlug,
          selectedWorkItem.orgId ? { orgId: selectedWorkItem.orgId } : undefined
        );
        const fresh = items.find(
          (item) => item.shortId === selectedWorkItem.shortId
        );
        if (!fresh) {
          // A collaborator may delete the item itself or its parent project
          // while this detail is open. Do not leave an editable ghost surface.
          setSelectedWorkItem(null);
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
      logger.warn("Failed to refresh chat panel work item", error);
    }
  }, [selectedWorkItem, setSelectedWorkItem]);

  useProjectDataChanged(
    useCallback(() => {
      void refreshSelectedWorkItem();
    }, [refreshSelectedWorkItem]),
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
  const orgPathLabel =
    selectedWorkItem.orgName || t("projects:orgs.personalOrg");
  const projectPathLabel =
    selectedWorkItem.projectName ||
    selectedWorkItem.workItem.project?.name ||
    t("projects.dashboardTitle");
  const workItemTitle = selectedWorkItem.workItem.name || "Work item";

  const handleOpenOrg = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
        projectOrg: {
          orgId: selectedWorkItem.orgId ?? STORY_PERSONAL_ORG_FILTER_ID,
          orgName: orgPathLabel,
          orgScope:
            selectedWorkItem.orgId === STORY_PERSONAL_ORG_FILTER_ID ||
            !selectedWorkItem.orgId
              ? STORY_ORG_SCOPE.PERSONAL_ORG
              : STORY_ORG_SCOPE.PROJECT_ORG,
        },
      });
    },
    [navigateChatPanel, orgPathLabel, selectedWorkItem.orgId]
  );

  const handleOpenProject = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!selectedWorkItem.sourceProject) return;
      navigateChatPanel({
        kind: CHAT_PANEL_SURFACE_KIND.PROJECT,
        project: selectedWorkItem.sourceProject,
      });
    },
    [navigateChatPanel, selectedWorkItem.sourceProject]
  );

  const headerBreadcrumbContent = useMemo(
    () => (
      <ChatPanelHeaderBreadcrumb
        items={[
          {
            key: "org",
            label: orgPathLabel,
            onClick: handleOpenOrg,
          },
          {
            key: "project",
            label: projectPathLabel,
            onClick: selectedWorkItem.sourceProject
              ? handleOpenProject
              : undefined,
          },
          {
            key: "work-item",
            label: workItemTitle,
          },
        ]}
      />
    ),
    [
      handleOpenOrg,
      handleOpenProject,
      orgPathLabel,
      projectPathLabel,
      selectedWorkItem.sourceProject,
      workItemTitle,
    ]
  );

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
      setSelectedWorkItem(null);
      await emit("orgii-data-changed");
    } catch (error) {
      logger.error("Failed to delete chat panel work item", error);
    }
  }, [selectedWorkItem, setSelectedWorkItem, t]);

  const headerDeleteAction = useMemo(
    () =>
      selectedWorkItem.projectSlug ? (
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
      ) : null,
    [handleDeleteWorkItem, selectedWorkItem.projectSlug, t]
  );

  usePublishChatPanelHeader({
    content: {
      content: headerBreadcrumbContent,
      trailing: headerDeleteAction,
    },
  });

  const inlineProperties = (
    <WorkItemProperties
      workItem={selectedWorkItem.workItem}
      onUpdate={handleUpdateWorkItem}
      fieldVariant="pill"
      visibleFields={WORK_ITEM_PROPERTY_INLINE_FIELDS}
      showMoreMenu
    />
  );

  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="chat-panel-work-item-detail"
    >
      <WorkItemContent
        key={workItemContentKey}
        workItem={selectedWorkItem.workItem}
        onUpdateWorkItem={handleUpdateWorkItem}
        onUpdateWorkItemImmediate={handleUpdateWorkItem}
        repoPath={repoPath}
        projectSlug={selectedWorkItem.projectSlug}
        shortId={selectedWorkItem.shortId}
        headerProperties={inlineProperties}
        titleVisible
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
      {floatingSessionId && (
        <div
          className="absolute inset-x-3 bottom-3 top-16 z-30 flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border-1 bg-chat-pane shadow-2xl"
          data-testid="work-item-floating-session-chat"
          data-session-id={floatingSessionId}
        >
          <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border-1 bg-bg-1/95 px-3 backdrop-blur">
            <div className="flex min-w-0 items-center gap-2">
              <ExternalLink size={14} className="shrink-0 text-text-3" />
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
            <ChatView
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
