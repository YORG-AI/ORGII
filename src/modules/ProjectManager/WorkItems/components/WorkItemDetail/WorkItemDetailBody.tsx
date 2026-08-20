import React from "react";

import type { WorkItemData as WorkItemDataPayload } from "@src/api/http/project";
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
  orgId?: string | null;
  shortId?: string | null;
  activeAgentSessionId?: string | null;
  onOpenSubItem?: (item: WorkItemDataPayload) => void;
  onUpdateWorkItem: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate: (updates: Partial<WorkItemExtended>) => void;
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
  orgId,
  shortId,
  activeAgentSessionId,
  onOpenSubItem,
  onUpdateWorkItem,
  onUpdateWorkItemImmediate,
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
              key={displayWorkItem.session_id}
              workItem={displayWorkItem}
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
              onOpenFileAtLine={onOpenFileAtLine}
              onReviewAllFiles={onReviewAllFiles}
              onOpenSubItem={onOpenSubItem}
              onRefreshWorkflow={onRefreshWorkItem}
              activeAgentSessionId={activeAgentSessionId}
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
