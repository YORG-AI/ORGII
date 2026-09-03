import type { FC, ReactNode } from "react";
import type React from "react";

import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";
import type { DropdownOption, Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

import type { WorkItemGroup } from "../../workItemsViewModel";
import WorkItemsCompactList from "../WorkItemsCompactList";
import WorkItemsListContent from "../WorkItemsListContent";

interface WorkItemsListSurfaceProps {
  groupedWorkItems: WorkItemGroup<WorkItemExtended>[];
  filteredWorkItems: WorkItemExtended[];
  selectedWorkItem: WorkItemExtended | null;
  selectedWorkItemId: string | null;
  workItems: WorkItemExtended[];
  availableMembers: Person[];
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  onSelectWorkItem: (workItemId: string) => void;
  checkedWorkItemIds?: Set<string>;
  onCheckedChange?: (workItemId: string, checked: boolean) => void;
  onUpdateWorkItem?: (
    workItemId: string,
    updates: Partial<WorkItemExtended>
  ) => void;
  onDeleteWorkItem?: (workItemId: string) => void;
  onRestoreWorkItem?: (workItemId: string) => void;
  onAddListItem?: (status: WorkItemStatus) => void | Promise<void>;
  listHeader?: ReactNode;
  detailContent?: ReactNode;
  propertiesPanel?: ReactNode;
  emptyListPlaceholder?: ReactNode;
  noResultsPlaceholder?: ReactNode;
  hidePropertiesPanel?: boolean;
  readonly?: boolean;
  workItemPrefix?: string;
  externalStatusOptions?: DropdownOption<string>[];
  getExternalStatusValue?: (workItem: WorkItemExtended) => string | undefined;
  onExternalStatusChange?: (
    workItemId: string,
    statusId: string
  ) => void | Promise<void>;
  statusDisabled?: boolean;
  collapseAllSignal?: number;
  /** Render project cells read-only (cross-project Work Items page). */
  disableProjectEdit?: boolean;
  /** Hide redundant project identity in a fixed project-scoped list. */
  hideProjectCell?: boolean;
  showEmptySections?: boolean;
  defaultCollapsedStatuses?: readonly string[];
  renderSectionPlaceholder?: (status: string) => ReactNode | undefined;
  onSectionExpandedChange?: (status: string, expanded: boolean) => void;
}

const EMPTY_CHECKED_WORK_ITEM_IDS = new Set<string>();

const WorkItemsListSurface: FC<WorkItemsListSurfaceProps> = ({
  groupedWorkItems,
  filteredWorkItems,
  selectedWorkItem,
  selectedWorkItemId,
  workItems,
  availableMembers,
  availableProjects = [],
  availableMilestones = [],
  availableLabels = [],
  onSelectWorkItem,
  checkedWorkItemIds = EMPTY_CHECKED_WORK_ITEM_IDS,
  onCheckedChange,
  onUpdateWorkItem,
  onDeleteWorkItem,
  onRestoreWorkItem,
  onAddListItem,
  listHeader,
  detailContent,
  propertiesPanel,
  emptyListPlaceholder,
  noResultsPlaceholder,
  hidePropertiesPanel = false,
  readonly = false,
  workItemPrefix,
  externalStatusOptions,
  getExternalStatusValue,
  onExternalStatusChange,
  statusDisabled = false,
  collapseAllSignal = 0,
  disableProjectEdit = false,
  hideProjectCell = false,
  showEmptySections = false,
  defaultCollapsedStatuses = [],
  renderSectionPlaceholder,
  onSectionExpandedChange,
}) => {
  const listContent = (
    <WorkItemsListContent
      groupedWorkItems={groupedWorkItems}
      filteredWorkItems={filteredWorkItems}
      workItems={workItems}
      selectedWorkItemId={selectedWorkItemId}
      availableMembers={availableMembers}
      availableProjects={availableProjects}
      availableMilestones={availableMilestones}
      availableLabels={availableLabels}
      checkedWorkItemIds={checkedWorkItemIds}
      onCheckedChange={onCheckedChange}
      onSelectWorkItem={onSelectWorkItem}
      onUpdateWorkItem={onUpdateWorkItem}
      onDeleteWorkItem={onDeleteWorkItem}
      onRestoreWorkItem={onRestoreWorkItem}
      onAddListItem={onAddListItem}
      emptyListPlaceholder={emptyListPlaceholder}
      noResultsPlaceholder={noResultsPlaceholder}
      readonly={readonly}
      workItemPrefix={workItemPrefix}
      externalStatusOptions={externalStatusOptions}
      getExternalStatusValue={getExternalStatusValue}
      onExternalStatusChange={onExternalStatusChange}
      statusDisabled={statusDisabled}
      collapseAllSignal={collapseAllSignal}
      disableProjectEdit={disableProjectEdit}
      hideProjectCell={hideProjectCell}
      showEmptySections={showEmptySections}
      defaultCollapsedStatuses={defaultCollapsedStatuses}
      renderSectionPlaceholder={renderSectionPlaceholder}
      onSectionExpandedChange={onSectionExpandedChange}
    />
  );

  const fullContent = (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="h-full min-h-0">{listContent}</div>
      </div>
      {!hidePropertiesPanel && propertiesPanel}
    </div>
  );

  return (
    <InboxListDetailLayout
      testId="project-work-items-list-detail-layout"
      detailOpen={Boolean(selectedWorkItem && detailContent)}
      fullContent={fullContent}
      listHeader={listHeader}
      listContent={
        <WorkItemsCompactList
          items={filteredWorkItems}
          selectedWorkItemId={selectedWorkItemId}
          onSelectWorkItem={onSelectWorkItem}
          workItemPrefix={workItemPrefix}
          testId="project-work-items-compact-list"
        />
      }
      detailContent={detailContent}
    />
  );
};

export default WorkItemsListSurface;
