import { emit } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronsRight, Info, ListChecks, Trash2 } from "lucide-react";
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
  type WorkItemData,
  enrichedWorkItemToUI,
  projectApi,
  standaloneWorkItemDataToEnriched,
  workItemDataToUI,
} from "@src/api/http/project";
import { projectSyncApi } from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { usePublishChatPanelHeader } from "@src/engines/ChatPanel/header";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import { WorkItemThreadSurface } from "@src/modules/ProjectManager/WorkItems/components";
import { WorkItemDetailHeaderBreadcrumb } from "@src/modules/ProjectManager/WorkItems/components/WorkItemDetail/WorkItemDetailHeader";
import WorkItemProperties from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties";
import { WorkItemThreadNavigationPortalContext } from "@src/modules/ProjectManager/WorkItems/components/WorkItemThread";
import { toWorkItemPartialUpdate } from "@src/modules/ProjectManager/WorkItems/workItemPartialUpdate";
import {
  PropertiesPanel,
  PropertiesRailFrame,
} from "@src/modules/ProjectManager/shared";
import { ExternalBrowserButton } from "@src/modules/WorkStation/shared/ExternalBrowserButton";
import {
  DetailHeaderTabs,
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "@src/modules/shared/layouts/blocks";
import { closeWorkItemChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  openSessionInNewChatTabAtom,
  openWorkItemInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  type ChatPanelSelectedWorkItem,
  chatPanelSelectedWorkItemAtom,
} from "@src/store/ui/chatPanelAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { WORK_ITEM_STATUS, type WorkItem } from "@src/types/core/workItem";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { useWorkItemGitHubIssueState } from "./useWorkItemGitHubIssueState";

const logger = createLogger("WorkItemPanelView");

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
  const openSessionTab = useSetAtom(openSessionInNewChatTabAtom);
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
  const [projectSyncAdapter, setProjectSyncAdapter] = useState<{
    projectSlug: string;
    adapterId: string | null;
  } | null>(null);
  const [propertiesOpen, setPropertiesOpen] = useState(true);
  const [navigationTrailHost, setNavigationTrailHost] =
    useState<HTMLDivElement | null>(null);
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

  // The owning work-item tab's stored payload is mirrored from
  // `chatPanelSelectedWorkItemAtom` by ChatPanel's patch effect. Refresh must
  // therefore write only the selection atom: writing the tab here as well
  // seeds a second, content-equal object into the tab slot, and the
  // selection<->tab mirror then shuffles the two distinct references forever
  // (React "maximum update depth"). One writer, one reference.
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
          closeWorkItemTab(selectedWorkItem);
          return;
        }
        const refreshedProjectItem = enrichedWorkItemToUI(fresh);
        setSelectedWorkItem((current) =>
          current?.projectSlug === selectedWorkItem.projectSlug &&
          current.shortId === selectedWorkItem.shortId &&
          current.orgId === selectedWorkItem.orgId
            ? { ...current, workItem: refreshedProjectItem }
            : current
        );
        return;
      }
      if (!selectedWorkItem.shortId) return;
      const data = await projectApi.readStandaloneWorkItem(
        selectedWorkItem.shortId,
        selectedWorkItem.orgId ? { orgId: selectedWorkItem.orgId } : undefined
      );
      const refreshedStandaloneItem = enrichedWorkItemToUI(
        standaloneWorkItemDataToEnriched(data)
      );
      setSelectedWorkItem((current) =>
        current?.shortId === selectedWorkItem.shortId &&
        current.orgId === selectedWorkItem.orgId
          ? { ...current, workItem: refreshedStandaloneItem }
          : current
      );
    } catch (error) {
      if (String(error).toLowerCase().includes("not found")) {
        // The single-item command resolves both the parent and item at the
        // authoritative SQLite boundary. Either tombstone makes this cached
        // tab invalid, without scanning every project and every work item.
        closeWorkItemTab(selectedWorkItem);
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

  const repoPath =
    selectedWorkItem.sourceProject?.project.linkedRepos?.[0]?.id ??
    activeWorkspaceRootPath ??
    null;

  const handleOpenSession = useCallback(
    (sessionId: string) => {
      openSessionTab({ sessionId });
    },
    [openSessionTab]
  );

  const openWorkItemTab = useSetAtom(openWorkItemInChatPanelTabAtom);
  const handleOpenFamilyItem = useCallback(
    (item: WorkItemData) => {
      const selection = {
        workItem: workItemDataToUI(item, {
          labelMap: new Map(),
          memberMap: new Map(),
        }),
        projectId: selectedWorkItem.projectId,
        projectName: selectedWorkItem.projectName,
        projectSlug: selectedWorkItem.projectSlug,
        shortId: item.frontmatter.short_id,
        orgId: selectedWorkItem.orgId,
      };
      setSelectedWorkItem(selection);
      openWorkItemTab(selection);
    },
    [
      openWorkItemTab,
      selectedWorkItem.orgId,
      selectedWorkItem.projectId,
      selectedWorkItem.projectName,
      selectedWorkItem.projectSlug,
      setSelectedWorkItem,
    ]
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
  const githubIssueExternalUrl = githubIssueState.externalUrl;
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
      closeWorkItemTab(selectedWorkItem);
      await emit("orgii-data-changed", {
        project_slug: selectedWorkItem.projectSlug,
        work_item_id: selectedWorkItem.shortId,
        source: "chat-panel-work-item-delete",
      });
    } catch (error) {
      logger.error("Failed to delete chat panel work item", error);
    }
  }, [closeWorkItemTab, selectedWorkItem, t]);

  const toggleProperties = useCallback(() => {
    setPropertiesOpen((current) => !current);
  }, []);
  const propertiesToggleLabel = propertiesOpen
    ? t("projects:workItems.hideProperties")
    : t("projects:workItems.showProperties");

  const headerActions = useMemo(
    () => (
      <div className="flex items-center gap-px">
        {selectedWorkItem.projectSlug &&
        projectSyncAdapterId !== undefined &&
        !isGitHubSyncedProject ? (
          <ToolbarTooltip label={t("projects:workItems.deleteWorkItem")}>
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
          </ToolbarTooltip>
        ) : null}
        {githubIssueExternalUrl ? (
          <ExternalBrowserButton
            href={githubIssueExternalUrl}
            dataTestId="chat-panel-work-item-open-external"
          />
        ) : null}
        <ToolbarTooltip label={propertiesToggleLabel}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={
              propertiesOpen ? "!bg-surface-selected !text-primary-6" : ""
            }
            onClick={toggleProperties}
            aria-label={propertiesToggleLabel}
            data-testid="chat-panel-work-item-properties-toggle"
            icon={<Info size={HEADER_ICON_SIZE.sm} />}
          />
        </ToolbarTooltip>
      </div>
    ),
    [
      handleDeleteWorkItem,
      githubIssueExternalUrl,
      isGitHubSyncedProject,
      projectSyncAdapterId,
      propertiesOpen,
      propertiesToggleLabel,
      selectedWorkItem.projectSlug,
      t,
      toggleProperties,
    ]
  );

  const workItemHeaderBreadcrumb = useMemo(
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
  const workItemHeaderContent = useMemo(
    () => <DetailHeaderTabs title={workItemHeaderBreadcrumb} />,
    [workItemHeaderBreadcrumb]
  );

  // Memoize the published-header payload. A fresh `{ content, trailing }`
  // object literal every render makes `usePublishChatPanelHeader`'s
  // layout effect re-publish on every commit; because the header atom's
  // subscriber re-render cascades back into this panel, that becomes an
  // unbounded synchronous update loop (React "maximum update depth").
  const publishedHeader = useMemo(
    () => ({ content: workItemHeaderContent, trailing: headerActions }),
    [workItemHeaderContent, headerActions]
  );
  usePublishChatPanelHeader({ content: publishedHeader });

  const propertiesPanel = (
    <PropertiesRailFrame floatingContent>
      <WorkstationTrailSurface className="flex self-start">
        <PropertiesPanel
          title={t("projects:workItems.properties.title")}
          fitContent
          headerVariant="workstation-trail"
          headerActions={
            <ToolbarTooltip label={propertiesToggleLabel}>
              <WorkstationTrailIconButton
                onClick={toggleProperties}
                aria-label={propertiesToggleLabel}
                data-testid="chat-panel-work-item-properties-collapse"
              >
                <ChevronsRight size={14} strokeWidth={1.75} />
              </WorkstationTrailIconButton>
            </ToolbarTooltip>
          }
        >
          <WorkItemProperties
            workItem={selectedWorkItem.workItem}
            onUpdate={handleUpdateWorkItem}
            availableProjects={
              selectedWorkItem.workItem.project
                ? [selectedWorkItem.workItem.project]
                : []
            }
            availableMilestones={
              selectedWorkItem.workItem.milestone
                ? [selectedWorkItem.workItem.milestone]
                : []
            }
            availableLabels={selectedWorkItem.workItem.labels ?? []}
            availableMembers={workItemMembers}
            projectIconType={
              isGitHubSyncedProject ? STORY_SYNC_ADAPTER.GITHUB : undefined
            }
            projectReadonly={projectSelectionReadonly}
            panelVariant="workstation-trail"
          />
        </PropertiesPanel>
      </WorkstationTrailSurface>
      <div
        ref={setNavigationTrailHost}
        className="pointer-events-none relative ml-auto min-h-0 w-11 flex-1"
        data-testid="chat-panel-work-item-navigation-trail-host"
      />
    </PropertiesRailFrame>
  );

  return (
    <WorkItemThreadNavigationPortalContext.Provider value={navigationTrailHost}>
      <div
        className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
        data-testid="chat-panel-work-item-detail"
      >
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <WorkItemThreadSurface
              key={workItemContentKey}
              workItem={selectedWorkItem.workItem}
              onUpdateWorkItem={handleUpdateWorkItem}
              onUpdateWorkItemImmediate={handleUpdateWorkItem}
              currentUser={currentUser ?? undefined}
              teamMembers={workItemMembers}
              repoPath={repoPath}
              projectSlug={selectedWorkItem.projectSlug || undefined}
              shortId={selectedWorkItem.shortId}
              orgId={selectedWorkItem.orgId}
              githubIssueTimeline={githubIssueState.timeline}
              githubIssueInteraction={githubIssueState.interaction}
              onOpenSession={handleOpenSession}
              onOpenSubItem={handleOpenFamilyItem}
              onRefreshWorkflow={refreshSelectedWorkItem}
            />
          </div>
          {propertiesOpen ? propertiesPanel : null}
        </div>
      </div>
    </WorkItemThreadNavigationPortalContext.Provider>
  );
};

export default WorkItemPanelView;
