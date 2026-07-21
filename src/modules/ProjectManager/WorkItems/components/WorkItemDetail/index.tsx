import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { HEADER_CLASSES } from "@src/config/workstation/tokens";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { getContextMenuItems } from "../../config";
import { useWorkItemOrchestrator } from "../../hooks/useWorkItemOrchestrator";
import WorkItemContextMenu from "../WorkItemContextMenu";
import { WorkItemDetailBody } from "./WorkItemDetailBody";
import {
  WorkItemDetailHeaderActions,
  WorkItemDetailHeaderBreadcrumb,
} from "./WorkItemDetailHeader";
import { usePendingWorkItemUpdates } from "./hooks/usePendingWorkItemUpdates";
import { usePrCreation } from "./hooks/usePrCreation";
import { useWorkItemFileActions } from "./hooks/useWorkItemFileActions";
import { WORK_ITEM_DETAIL_SURFACE, type WorkItemDetailProps } from "./types";

export {
  WORK_ITEM_DETAIL_SURFACE,
  type WorkItemDetailActions,
  type WorkItemDetailSurface,
} from "./types";

const ROLE_LABELS: Record<string, string> = {
  coding: "Coding",
  sde: "Coding",
  review: "Review",
  follow_up: "Follow-up",
};

const WORK_ITEM_INFO_PANEL_DEFAULT_WIDTH = 240;

const WorkItemDetail: React.FC<WorkItemDetailProps> = ({
  workItem,
  onClose: _onClose,
  onNavigate,
  hasPrev,
  hasNext,
  onUpdateWorkItem,
  onDeleteWorkItem,
  availableProjects = [],
  availableMilestones = [],
  availableLabels = [],
  availableMembers = [],
  externalStatusConfig,
  showTime = true,
  onPendingChangesChange,
  externalSaveBar: _externalSaveBar = false,
  onRegisterActions,
  repoPath,
  projectSlug,
  shortId,
  onRefreshWorkItem,
  onOpenSession,
  onExpandToTab,
  initialPendingUpdates,
  surface = WORK_ITEM_DETAIL_SURFACE.main,
  breadcrumbProjectName,
  breadcrumbIcon,
  propertiesOpen: controlledPropertiesOpen,
  onToggleProperties,
  publishHeaderToWorkstation = false,
  workstationHeaderHost = "project",
}) => {
  const { t } = useTranslation("projects");
  const { agents: customAgents } = useAgentDefinitions();
  const { orgs: availableOrgs } = useAgentOrgs();
  const propertiesOpen = controlledPropertiesOpen ?? true;
  const [infoPanelWidth, setInfoPanelWidth] = useState(
    WORK_ITEM_INFO_PANEL_DEFAULT_WIDTH
  );
  const lastAutoRefreshWorkItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastAutoRefreshWorkItemIdRef.current === workItem.session_id) return;
    lastAutoRefreshWorkItemIdRef.current = workItem.session_id;
    onRefreshWorkItem?.();
  }, [onRefreshWorkItem, workItem.session_id]);

  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const {
    displayWorkItem,
    pendingUpdates,
    hasPendingChanges,
    handleLocalUpdate,
    handleImmediateUpdate,
    handleSave,
  } = usePendingWorkItemUpdates({
    workItem,
    initialPendingUpdates,
    onUpdateWorkItem,
    onPendingChangesChange,
    onRegisterActions,
  });

  const {
    isStartingAgent,
    activeAgentSessionId,
    activeAgentRole,
    handleStartAgent,
    handleRetry,
    handleCancelAgent,
    handleAcceptAsIs,
    handleCreateFollowUp,
    worktreePath,
    projectRepoPath,
    isLockedByOther,
    lockHolderName,
  } = useWorkItemOrchestrator({
    workItem,
    displayWorkItem,
    repoPath,
    projectSlug,
    shortId,
    onRefreshWorkItem,
    onUpdateWorkItem,
    hasPendingChanges,
    handleSave,
  });

  const { handleOpenFileDiff, handleOpenFileAtLine, handleReviewAllFiles } =
    useWorkItemFileActions(repoPath);

  const handleOpenSessionWithContext = useCallback(
    (sessionId: string) => {
      if (!onOpenSession) return;
      const linkedSession = workItem.linkedSessions?.find(
        (linkedSessionItem) => linkedSessionItem.session_id === sessionId
      );
      const role = linkedSession?.agent_role ?? activeAgentRole;
      const roleLabel = role ? (ROLE_LABELS[role] ?? role) : "";
      const prefix = shortId ? `[${shortId}]` : "";
      const title = [prefix, roleLabel, "Chat"].filter(Boolean).join(" ");
      onOpenSession(sessionId, title);
    },
    [onOpenSession, workItem.linkedSessions, activeAgentRole, shortId]
  );

  const { handleCreatePr } = usePrCreation({
    workItemName: workItem.name,
    branch: workItem.proofOfWork?.branch,
    worktreePath,
    projectRepoPath,
    projectSlug,
    shortId,
    onRefreshWorkItem,
  });

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  const handleContextAction = useCallback(
    (action: string, value?: string) => {
      switch (action) {
        case "status":
          if (value) {
            handleImmediateUpdate({ workItemStatus: value as WorkItemStatus });
          }
          break;
        case "priority":
          if (value) {
            handleImmediateUpdate({ priority: value as WorkItemPriority });
          }
          break;
        case "assignee": {
          const assignee = availableMembers.find(
            (member) => member.id === value
          );
          handleImmediateUpdate({
            assignee: value === "none" ? undefined : assignee,
            assigneeType: value === "none" ? undefined : "human",
          });
          break;
        }
        case "lead": {
          const lead = availableMembers.find((member) => member.id === value);
          handleImmediateUpdate({
            lead: value === "none" || !lead ? [] : [lead],
          });
          break;
        }
        case "member": {
          const member = availableMembers.find((item) => item.id === value);
          if (!member) break;
          const members = displayWorkItem.members ?? [];
          const exists = members.some((item) => item.id === member.id);
          handleImmediateUpdate({
            members: exists
              ? members.filter((item) => item.id !== member.id)
              : [...members, member],
          });
          break;
        }
        case "label": {
          const label = availableLabels.find((item) => item.id === value);
          if (!label) break;
          const labels = displayWorkItem.labels ?? [];
          const exists = labels.some((item) => item.id === label.id);
          handleImmediateUpdate({
            labels: exists
              ? labels.filter((item) => item.id !== label.id)
              : [...labels, label],
          });
          break;
        }
        case "project": {
          const project = availableProjects.find((item) => item.id === value);
          handleImmediateUpdate({
            project: value === "none" ? undefined : project,
          });
          break;
        }
        case "milestone": {
          const milestone = availableMilestones.find(
            (item) => item.id === value
          );
          handleImmediateUpdate({
            milestone: value === "none" ? undefined : milestone,
          });
          break;
        }
        case "delete":
          onDeleteWorkItem?.(workItem.session_id);
          break;
        default:
          break;
      }
    },
    [
      availableLabels,
      availableMembers,
      availableMilestones,
      availableProjects,
      displayWorkItem.labels,
      displayWorkItem.members,
      handleImmediateUpdate,
      onDeleteWorkItem,
      workItem.session_id,
    ]
  );

  const contextMenuItems = useMemo(
    () =>
      getContextMenuItems(handleContextAction, t, {
        workItem: displayWorkItem,
        availableMembers,
        availableProjects,
        availableMilestones,
        availableLabels,
      }),
    [
      availableLabels,
      availableMembers,
      availableMilestones,
      availableProjects,
      displayWorkItem,
      handleContextAction,
      t,
    ]
  );

  const headerContent = useMemo(
    () => (
      <WorkItemDetailHeaderBreadcrumb
        workItem={workItem}
        breadcrumbProjectName={breadcrumbProjectName}
        breadcrumbIcon={breadcrumbIcon}
        shortId={shortId}
        onClose={_onClose}
        t={t}
      />
    ),
    [workItem, breadcrumbProjectName, breadcrumbIcon, shortId, _onClose, t]
  );

  const headerTrailing = useMemo(
    () => (
      <WorkItemDetailHeaderActions
        workItem={workItem}
        pendingUpdates={pendingUpdates}
        propertiesOpen={propertiesOpen}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onNavigate={onNavigate}
        onDeleteWorkItem={onDeleteWorkItem}
        onExpandToTab={onExpandToTab}
        onToggleProperties={onToggleProperties}
        t={t}
      />
    ),
    [
      workItem,
      pendingUpdates,
      propertiesOpen,
      hasPrev,
      hasNext,
      onNavigate,
      onDeleteWorkItem,
      onExpandToTab,
      onToggleProperties,
      t,
    ]
  );

  usePublishWorkstationTabHeader({
    host: workstationHeaderHost,
    content: {
      content: headerContent,
      trailing: headerTrailing,
    },
    enabled: publishHeaderToWorkstation,
  });

  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden${
        surface === WORK_ITEM_DETAIL_SURFACE.nested ? "bg-bg-2" : ""
      }`}
      data-testid="work-item-detail"
      data-work-item-id={workItem.session_id}
      data-work-item-short-id={shortId ?? ""}
      onContextMenu={handleContextMenu}
    >
      {!publishHeaderToWorkstation && (
        <div className={HEADER_CLASSES.pageHeader}>
          {headerContent}
          {headerTrailing}
        </div>
      )}

      <WorkItemDetailBody
        displayWorkItem={displayWorkItem}
        propertiesOpen={propertiesOpen}
        infoPanelWidth={infoPanelWidth}
        setInfoPanelWidth={setInfoPanelWidth}
        availableProjects={availableProjects}
        availableMilestones={availableMilestones}
        availableLabels={availableLabels}
        availableMembers={availableMembers}
        externalStatusConfig={externalStatusConfig}
        availableAgents={customAgents}
        availableOrgs={availableOrgs}
        showTime={showTime}
        repoPath={repoPath}
        projectSlug={projectSlug}
        shortId={shortId}
        isStartingAgent={isStartingAgent}
        activeAgentSessionId={activeAgentSessionId}
        activeAgentRole={activeAgentRole}
        isLockedByOther={isLockedByOther}
        lockHolderName={lockHolderName}
        onUpdateWorkItem={handleLocalUpdate}
        onUpdateWorkItemImmediate={handleImmediateUpdate}
        onStartAgent={handleStartAgent}
        onCancelAgent={handleCancelAgent}
        onRetry={handleRetry}
        onAcceptAsIs={handleAcceptAsIs}
        onCreateFollowUp={handleCreateFollowUp}
        onOpenSession={handleOpenSessionWithContext}
        onOpenFileDiff={handleOpenFileDiff}
        onOpenFileAtLine={handleOpenFileAtLine}
        onReviewAllFiles={handleReviewAllFiles}
        onRefreshWorkItem={onRefreshWorkItem}
        onCreatePr={handleCreatePr}
      />

      {contextMenuPosition && (
        <WorkItemContextMenu
          items={contextMenuItems}
          position={contextMenuPosition}
          onClose={handleCloseContextMenu}
        />
      )}
    </div>
  );
};

export default WorkItemDetail;
