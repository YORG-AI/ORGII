import React from "react";

import { useResizeHandle } from "@src/hooks/ui/useResizeHandle";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import { PropertiesRailFrame } from "@src/modules/ProjectManager/shared";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import type { AgentRole } from "../../constants";
import WorkItemContent from "../WorkItemContent";
import WorkItemProperties from "../WorkItemProperties";
import type { WorkItemExternalStatusConfig } from "../WorkItemProperties/types";

const WORK_ITEM_INFO_PANEL_MIN_WIDTH = 200;
const WORK_ITEM_INFO_PANEL_MAX_WIDTH = 280;

interface WorkItemDetailBodyProps {
  displayWorkItem: WorkItemExtended;
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
  shortId?: string | null;
  isStartingAgent: boolean;
  activeAgentSessionId?: string | null;
  activeAgentRole?: AgentRole | null;
  isLockedByOther: boolean;
  lockHolderName: string | null;
  onUpdateWorkItem: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate: (updates: Partial<WorkItemExtended>) => void;
  onStartAgent: (instructions?: string) => void;
  onCancelAgent: () => void;
  onRetry: (instructions?: string) => void;
  onAcceptAsIs: () => void;
  onCreateFollowUp: () => void;
  onOpenSession: (sessionId: string, title?: string) => void;
  onOpenFileDiff: (filePath: string) => void;
  onOpenFileAtLine: (filePath: string, line?: number) => void;
  onReviewAllFiles: (filePaths: string[]) => void;
  onRefreshWorkItem?: () => void;
  onCreatePr: () => Promise<{ url?: string; error?: string }>;
}

export function WorkItemDetailBody({
  displayWorkItem,
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
  shortId,
  isStartingAgent,
  activeAgentSessionId,
  activeAgentRole,
  isLockedByOther,
  lockHolderName,
  onUpdateWorkItem,
  onUpdateWorkItemImmediate,
  onStartAgent,
  onCancelAgent,
  onRetry,
  onAcceptAsIs,
  onCreateFollowUp,
  onOpenSession,
  onOpenFileDiff,
  onOpenFileAtLine,
  onReviewAllFiles,
  onRefreshWorkItem,
  onCreatePr,
}: WorkItemDetailBodyProps) {
  const { handleMouseDown: handleInfoPanelResize, isResizing } =
    useResizeHandle(infoPanelWidth, setInfoPanelWidth, {
      direction: "horizontal",
      minSize: WORK_ITEM_INFO_PANEL_MIN_WIDTH,
      maxSize: WORK_ITEM_INFO_PANEL_MAX_WIDTH,
      isReversed: true,
    });

  const propertiesContent = (
    <WorkItemProperties
      workItem={displayWorkItem}
      onUpdate={onUpdateWorkItem}
      availableProjects={availableProjects}
      availableMilestones={availableMilestones}
      availableLabels={availableLabels}
      availableMembers={availableMembers}
      externalStatusConfig={externalStatusConfig}
      availableAgents={availableAgents}
      availableOrgs={availableOrgs}
      showTime={showTime}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col overflow-visible">
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkItemContent
              workItem={displayWorkItem}
              onUpdateWorkItem={onUpdateWorkItem}
              onUpdateWorkItemImmediate={onUpdateWorkItemImmediate}
              teamMembers={availableMembers}
              repoPath={repoPath}
              projectSlug={projectSlug}
              shortId={shortId}
              onStartAgent={onStartAgent}
              isStartingAgent={isStartingAgent}
              onCancelAgent={onCancelAgent}
              onRetry={onRetry}
              onAcceptAsIs={onAcceptAsIs}
              onCreateFollowUp={onCreateFollowUp}
              onOpenSession={onOpenSession}
              onOpenFileDiff={onOpenFileDiff}
              onOpenFileAtLine={onOpenFileAtLine}
              onReviewAllFiles={onReviewAllFiles}
              onRefreshWorkflow={onRefreshWorkItem}
              activeAgentSessionId={activeAgentSessionId}
              activeAgentRole={activeAgentRole}
              isLockedByOther={isLockedByOther}
              lockHolderName={lockHolderName}
              onCreatePr={onCreatePr}
            />
          </div>
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
