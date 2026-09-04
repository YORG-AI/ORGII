import React from "react";
import { useTranslation } from "react-i18next";

import type { WorkItemData as WorkItemDataPayload } from "@src/api/http/project";
import { useResizeHandle } from "@src/hooks/ui/useResizeHandle";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import {
  PropertiesPanel,
  PropertiesRailFrame,
} from "@src/modules/ProjectManager/shared";
import LazyGitHubLinkedReferences from "@src/modules/shared/components/GitHubLinkedReferences/lazy";
import type { ExtractedGitHubReference } from "@src/modules/shared/components/GitHubLinkedReferences/references";
import type { ThreadDetailTab } from "@src/modules/shared/components/ThreadDetailTabs";
import DetailPaneErrorBoundary from "@src/modules/shared/layouts/DetailPaneErrorBoundary";
import {
  PersistentDetailTabPanel,
  WorkstationTrailSurface,
} from "@src/modules/shared/layouts/blocks";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import WorkItemContent from "../WorkItemContent";
import WorkItemProperties from "../WorkItemProperties";
import type { WorkItemExternalStatusConfig } from "../WorkItemProperties/types";

const WORK_ITEM_INFO_PANEL_MIN_WIDTH = 200;
const WORK_ITEM_INFO_PANEL_MAX_WIDTH = 280;

interface WorkItemDetailBodyProps {
  displayWorkItem: WorkItemExtended;
  activeTab: ThreadDetailTab;
  linkedReferences: readonly ExtractedGitHubReference[];
  propertiesOpen: boolean;
  infoPanelWidth: number;
  setInfoPanelWidth: React.Dispatch<React.SetStateAction<number>>;
  availableProjects: WorkItemProject[];
  availableMilestones: WorkItemMilestone[];
  availableLabels: WorkItemLabel[];
  availableMembers: Person[];
  externalStatusConfig?: WorkItemExternalStatusConfig;
  availableAgents: AgentDefinition[];
  availableOrgs: OrgMember[];
  showTime: boolean;
  repoPath?: string | null;
  projectSlug?: string | null;
  orgId?: string | null;
  shortId?: string | null;
  activeAgentSessionId?: string | null;
  onOpenSubItem?: (item: WorkItemDataPayload) => void;
  onUpdateWorkItem: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate: (updates: Partial<WorkItemExtended>) => void;
  onOpenSession: (sessionId: string, title?: string) => void;
  onOpenFileDiff: (filePath: string) => void;
  onReviewAllFiles: (filePaths: string[]) => void;
  onRefreshWorkItem?: () => void;
  onCreatePr: () => Promise<{ url?: string; error?: string }>;
}

export function WorkItemDetailBody({
  displayWorkItem,
  activeTab,
  linkedReferences,
  propertiesOpen,
  infoPanelWidth,
  setInfoPanelWidth,
  availableProjects,
  availableMilestones,
  availableLabels,
  availableMembers,
  externalStatusConfig,
  availableAgents,
  availableOrgs,
  showTime,
  repoPath,
  projectSlug,
  orgId,
  shortId,
  activeAgentSessionId,
  onOpenSubItem,
  onUpdateWorkItem,
  onUpdateWorkItemImmediate,
  onOpenSession,
  onOpenFileDiff,
  onReviewAllFiles,
  onRefreshWorkItem,
  onCreatePr,
}: WorkItemDetailBodyProps) {
  const { t } = useTranslation("projects");
  const { handleMouseDown: handleInfoPanelResize, isResizing } =
    useResizeHandle(infoPanelWidth, setInfoPanelWidth, {
      direction: "horizontal",
      minSize: WORK_ITEM_INFO_PANEL_MIN_WIDTH,
      maxSize: WORK_ITEM_INFO_PANEL_MAX_WIDTH,
      isReversed: true,
    });

  // Same trail-surface composition as the chat-panel Work Item properties
  // rail and the PR detail sidebar, so every properties rail matches.
  const propertiesContent = (
    <WorkstationTrailSurface className="flex self-start">
      <PropertiesPanel
        title={t("workItems.properties.title")}
        fitContent
        headerVariant="workstation-trail"
      >
        <WorkItemProperties
          workItem={displayWorkItem}
          onUpdate={onUpdateWorkItem}
          availableProjects={availableProjects}
          availableMilestones={availableMilestones}
          availableLabels={availableLabels}
          availableMembers={availableMembers}
          externalStatusConfig={externalStatusConfig}
          showTime={showTime}
          panelVariant="workstation-trail"
        />
      </PropertiesPanel>
    </WorkstationTrailSurface>
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-visible">
          <PersistentDetailTabPanel
            active={activeTab === "conversation"}
            id="work-item-detail-tabpanel-conversation"
            ariaLabelledBy="work-item-detail-tab-conversation"
            className="min-h-0 min-w-0 overflow-hidden"
          >
            <DetailPaneErrorBoundary
              key={`${displayWorkItem.session_id}:conversation`}
              label={t("workItems.detail.conversation", {
                defaultValue: "Conversation",
              })}
              onRetry={onRefreshWorkItem}
            >
              <WorkItemContent
                key={displayWorkItem.session_id}
                workItem={displayWorkItem}
                presentation="thread"
                onUpdateWorkItem={onUpdateWorkItem}
                onUpdateWorkItemImmediate={onUpdateWorkItemImmediate}
                teamMembers={availableMembers}
                availableAgents={availableAgents}
                availableOrgs={availableOrgs}
                repoPath={repoPath}
                projectSlug={projectSlug}
                orgId={orgId}
                shortId={shortId}
                onOpenSession={onOpenSession}
                onOpenFileDiff={onOpenFileDiff}
                onReviewAllFiles={onReviewAllFiles}
                onOpenSubItem={onOpenSubItem}
                onRefreshWorkflow={onRefreshWorkItem}
                activeAgentSessionId={activeAgentSessionId}
                onCreatePr={onCreatePr}
              />
            </DetailPaneErrorBoundary>
          </PersistentDetailTabPanel>
          <PersistentDetailTabPanel
            active={activeTab === "linked"}
            id="work-item-detail-tabpanel-linked"
            ariaLabelledBy="work-item-detail-tab-linked"
            className="min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <DetailPaneErrorBoundary
              key={`${displayWorkItem.session_id}:linked`}
              label={t("workItems.detail.linked", { defaultValue: "Linked" })}
            >
              <LazyGitHubLinkedReferences
                references={linkedReferences}
                repoPath={repoPath}
                enabled={activeTab === "linked"}
              />
            </DetailPaneErrorBoundary>
          </PersistentDetailTabPanel>
        </div>
      </div>

      {propertiesOpen && (
        <>
          <VerticalResizeHandle
            variant="transparent"
            onMouseDown={handleInfoPanelResize}
            isResizing={isResizing}
          />
          <PropertiesRailFrame width={infoPanelWidth} floatingContent>
            {propertiesContent}
          </PropertiesRailFrame>
        </>
      )}
    </div>
  );
}
