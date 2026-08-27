import type React from "react";
import { type FC, type ReactNode, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import VirtualizedGroupedList, {
  type VirtualizedGroup,
} from "@src/modules/ProjectManager/shared/components/VirtualizedGroupedList";
import { PROJECT_MANAGER_PLACEHOLDER_PLACEMENT } from "@src/modules/ProjectManager/shared/placeholderTokens";
import type { DropdownOption, Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { WORK_ITEMS_DEFAULT_STATUS } from "../../types";
import type { WorkItemGroup } from "../../workItemsViewModel";
import WorkItemRow from "../WorkItemRow";
import WorkItemSection from "../WorkItemSection";

interface WorkItemsListContentProps {
  groupedWorkItems: WorkItemGroup<WorkItemExtended>[];
  filteredWorkItems: WorkItemExtended[];
  workItems: WorkItemExtended[];
  selectedWorkItemId: string | null;
  availableMembers: Person[];
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  checkedWorkItemIds?: Set<string>;
  onCheckedChange?: (workItemId: string, checked: boolean) => void;
  onSelectWorkItem: (workItemId: string) => void;
  onUpdateWorkItem?: (
    workItemId: string,
    updates: Partial<WorkItemExtended>
  ) => void;
  onDeleteWorkItem?: (workItemId: string) => void;
  onRestoreWorkItem?: (workItemId: string) => void;
  readonly?: boolean;
  onAddListItem?: (status: WorkItemStatus) => void | Promise<void>;
  emptyListPlaceholder?: ReactNode;
  noResultsPlaceholder?: ReactNode;
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
  compactRows?: boolean;
  showEmptySections?: boolean;
  defaultCollapsedStatuses?: readonly string[];
  renderSectionPlaceholder?: (status: string) => ReactNode | undefined;
  onSectionExpandedChange?: (status: string, expanded: boolean) => void;
}

const EMPTY_CHECKED_WORK_ITEM_IDS = new Set<string>();

interface SectionPlaceholderRow {
  kind: "section-placeholder";
  status: string;
  content: ReactNode;
}

type WorkItemVirtualRow = WorkItemExtended | SectionPlaceholderRow;

function isSectionPlaceholder(
  row: WorkItemVirtualRow
): row is SectionPlaceholderRow {
  return "kind" in row && row.kind === "section-placeholder";
}

const WorkItemsListContent: FC<WorkItemsListContentProps> = ({
  groupedWorkItems,
  filteredWorkItems,
  workItems,
  selectedWorkItemId,
  availableMembers,
  availableProjects = [],
  availableMilestones = [],
  availableLabels = [],
  checkedWorkItemIds = EMPTY_CHECKED_WORK_ITEM_IDS,
  onCheckedChange,
  onSelectWorkItem,
  onUpdateWorkItem,
  onDeleteWorkItem,
  onRestoreWorkItem,
  readonly = false,
  onAddListItem,
  emptyListPlaceholder,
  noResultsPlaceholder,
  workItemPrefix,
  externalStatusOptions,
  getExternalStatusValue,
  onExternalStatusChange,
  statusDisabled = false,
  collapseAllSignal = 0,
  disableProjectEdit = false,
  hideProjectCell = false,
  compactRows = false,
  showEmptySections = false,
  defaultCollapsedStatuses = [],
  renderSectionPlaceholder,
  onSectionExpandedChange,
}) => {
  const { t } = useTranslation("projects");

  const hasControlledCheckboxes = !!onCheckedChange;
  const showCheckboxesOnAllRows = useMemo(
    () => hasControlledCheckboxes && checkedWorkItemIds.size > 0,
    [checkedWorkItemIds, hasControlledCheckboxes]
  );

  const shouldRenderSections =
    groupedWorkItems.length > 0 &&
    (filteredWorkItems.length > 0 || showEmptySections);

  const virtualGroups = useMemo(
    () =>
      groupedWorkItems.map((group) => {
        const placeholder = renderSectionPlaceholder?.(group.status);
        return {
          key: group.status,
          group,
          items: placeholder
            ? ([
                {
                  kind: "section-placeholder",
                  status: group.status,
                  content: placeholder,
                },
              ] satisfies SectionPlaceholderRow[])
            : (group.items as readonly WorkItemVirtualRow[]),
        };
      }),
    [groupedWorkItems, renderSectionPlaceholder]
  );

  const defaultGroupExpanded = useCallback(
    (
      virtualGroup: VirtualizedGroup<
        WorkItemGroup<WorkItemExtended>,
        WorkItemVirtualRow
      >
    ) => {
      const { group } = virtualGroup;
      return (
        collapseAllSignal === 0 &&
        group.status !== "deleted" &&
        !defaultCollapsedStatuses.includes(group.status)
      );
    },
    [collapseAllSignal, defaultCollapsedStatuses]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        {!shouldRenderSections ? (
          workItems.length === 0 ? (
            (emptyListPlaceholder ?? (
              <Placeholder
                variant="empty"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={t("workItems.noWorkItems")}
                subtitle={t("workItems.noWorkItemsSubtitle")}
                action={
                  onAddListItem
                    ? {
                        label: t("workItems.addFirstWorkItem"),
                        onClick: () => {
                          void onAddListItem(WORK_ITEMS_DEFAULT_STATUS);
                        },
                      }
                    : undefined
                }
                fillParentHeight
              />
            ))
          ) : (
            (noResultsPlaceholder ?? (
              <Placeholder
                variant="no-results"
                placement={PROJECT_MANAGER_PLACEHOLDER_PLACEMENT}
                title={t("workItems.noResults")}
                fillParentHeight
              />
            ))
          )
        ) : (
          <VirtualizedGroupedList
            key={collapseAllSignal}
            testId="work-items-virtual-list"
            groups={virtualGroups}
            defaultExpanded={defaultGroupExpanded}
            getItemKey={(row) =>
              isSectionPlaceholder(row)
                ? `placeholder:${row.status}`
                : row.session_id
            }
            renderGroupHeader={(group, expanded, onExpandedChange) => {
              const isDeletedGroup = group.status === "deleted";
              return (
                <WorkItemSection
                  status={group.status}
                  statusConfig={group.config}
                  count={group.items.length}
                  expanded={expanded}
                  label={
                    isDeletedGroup ? t("workItems.deleteBin.title") : undefined
                  }
                  onAddItem={
                    onAddListItem && !isDeletedGroup
                      ? () => {
                          void onAddListItem(group.status as WorkItemStatus);
                        }
                      : undefined
                  }
                  compact={compactRows}
                  onExpandedChange={(nextExpanded) => {
                    onExpandedChange(nextExpanded);
                    onSectionExpandedChange?.(group.status, nextExpanded);
                  }}
                  virtualizedHeader
                  variant="table"
                />
              );
            }}
            renderItem={(row, group) => {
              const isDeletedGroup = group.status === "deleted";
              if (isSectionPlaceholder(row)) {
                return <div>{row.content}</div>;
              }
              return (
                <div>
                  <WorkItemRow
                    workItem={row}
                    isSelected={selectedWorkItemId === row.session_id}
                    variant="table"
                    onSelect={onSelectWorkItem}
                    onUpdate={onUpdateWorkItem}
                    onDelete={onDeleteWorkItem}
                    onRestore={onRestoreWorkItem}
                    readonly={readonly}
                    compact={compactRows}
                    availableMembers={availableMembers}
                    availableProjects={availableProjects}
                    availableMilestones={availableMilestones}
                    availableLabels={availableLabels}
                    isChecked={
                      hasControlledCheckboxes
                        ? checkedWorkItemIds.has(row.session_id)
                        : undefined
                    }
                    onCheckedChange={onCheckedChange}
                    workItemPrefix={workItemPrefix}
                    showCheckboxes={showCheckboxesOnAllRows && !isDeletedGroup}
                    externalStatusValue={getExternalStatusValue?.(row)}
                    externalStatusOptions={externalStatusOptions}
                    onExternalStatusChange={
                      onExternalStatusChange
                        ? (statusId) =>
                            onExternalStatusChange(row.session_id, statusId)
                        : undefined
                    }
                    statusDisabled={statusDisabled || isDeletedGroup}
                    disableProjectEdit={disableProjectEdit}
                    hideProjectCell={hideProjectCell}
                  />
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
};

export default WorkItemsListContent;
