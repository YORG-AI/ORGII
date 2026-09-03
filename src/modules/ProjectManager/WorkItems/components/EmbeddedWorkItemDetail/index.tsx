import React, { Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { WorkstationTabHeaderHost } from "@src/hooks/tabHost/useWorkstationTabHeader";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import DetailPaneLayout, {
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import {
  WORK_ITEM_DETAIL_SURFACE,
  type WorkItemDetailActions,
} from "../WorkItemDetail";

const WorkItemDetail = React.lazy(() => import("../WorkItemDetail"));

interface EmbeddedWorkItemDetailProps {
  workItem: WorkItemExtended | null;
  onClose: () => void;
  onOpenInNewTab?: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  hasPrev: boolean;
  hasNext: boolean;
  onUpdateWorkItem: (
    workItemId: string,
    updates: Partial<WorkItemExtended>
  ) => void;
  onDeleteWorkItem: (workItemId: string) => Promise<void>;
  availableMembers: Person[];
  availableProjects: WorkItemProject[];
  availableMilestones: WorkItemMilestone[];
  availableLabels: WorkItemLabel[];
  onPendingChangesChange: (hasPending: boolean) => void;
  onRegisterActions?: (actions: WorkItemDetailActions) => void;
  repoPath: string | null;
  projectSlug: string | null;
  shortId: string | null;
  onRefreshWorkItem: () => Promise<void>;
  onOpenSession?: (sessionId: string, title?: string) => void;
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  breadcrumbProjectName: string;
  breadcrumbIcon?: React.ReactNode;
  titleEditable: boolean;
  propertiesOpen: boolean;
  onToggleProperties: () => void;
  publishHeaderToWorkstation: boolean;
  workstationHeaderHost?: WorkstationTabHeaderHost;
}

const EmbeddedWorkItemDetail: React.FC<EmbeddedWorkItemDetailProps> = ({
  workItem,
  onClose,
  onOpenInNewTab,
  onNavigate,
  hasPrev,
  hasNext,
  onUpdateWorkItem,
  onDeleteWorkItem,
  availableMembers,
  availableProjects,
  availableMilestones,
  availableLabels,
  onPendingChangesChange,
  onRegisterActions,
  repoPath,
  projectSlug,
  shortId,
  onRefreshWorkItem,
  onOpenSession,
  breadcrumbSegments,
  breadcrumbProjectName,
  breadcrumbIcon,
  titleEditable,
  propertiesOpen,
  onToggleProperties,
  publishHeaderToWorkstation,
  workstationHeaderHost,
}) => {
  const { t } = useTranslation("common");
  const handleUpdateWorkItem = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      if (!workItem) return;
      onUpdateWorkItem(workItem.session_id, updates);
    },
    [onUpdateWorkItem, workItem]
  );

  if (!workItem) {
    return (
      <DetailPaneLayout testId="work-item-detail-placeholder">
        <DetailPanePlaceholder
          variant="empty"
          title={t("teamInbox.empty.selectTitle")}
          subtitle={t("teamInbox.empty.selectSubtitle")}
        />
      </DetailPaneLayout>
    );
  }

  return (
    <Suspense
      fallback={
        <DetailPaneLayout
          onClose={onClose}
          closeTestId="work-item-close-detail"
        >
          <DetailPanePlaceholder variant="loading" />
        </DetailPaneLayout>
      }
    >
      <WorkItemDetail
        workItem={workItem}
        onClose={onClose}
        onOpenInNewTab={onOpenInNewTab}
        onNavigate={onNavigate}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onUpdateWorkItem={handleUpdateWorkItem}
        onDeleteWorkItem={onDeleteWorkItem}
        availableMembers={availableMembers}
        availableProjects={availableProjects}
        availableMilestones={availableMilestones}
        availableLabels={availableLabels}
        showTime={true}
        onPendingChangesChange={onPendingChangesChange}
        externalSaveBar={true}
        onRegisterActions={onRegisterActions}
        repoPath={repoPath}
        projectSlug={projectSlug}
        shortId={shortId}
        onRefreshWorkItem={onRefreshWorkItem}
        onOpenSession={onOpenSession}
        surface={WORK_ITEM_DETAIL_SURFACE.nested}
        breadcrumbSegments={breadcrumbSegments}
        breadcrumbProjectName={breadcrumbProjectName}
        breadcrumbIcon={breadcrumbIcon}
        titleEditable={titleEditable}
        propertiesOpen={propertiesOpen}
        onToggleProperties={onToggleProperties}
        publishHeaderToWorkstation={publishHeaderToWorkstation}
        workstationHeaderHost={workstationHeaderHost}
      />
    </Suspense>
  );
};

export default EmbeddedWorkItemDetail;
