import { RotateCcw } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import IntegrationIcon from "@src/components/IntegrationIcon";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItemPriority,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { getContextMenuItems } from "../../config";
import {
  formatWorkItemShortId,
  getWorkItemSourceIntegration,
  isGitHubIssueStatus,
} from "../../workItemIdentity";
import WorkItemContextMenu from "../WorkItemContextMenu";
import { AssigneeCell } from "./AssigneeCell";
import { DueDateCell } from "./DueDateCell";
import { LeadingCells } from "./LeadingCells";
import { MetadataCells } from "./MetadataCells";
import { TitleCell } from "./TitleCell";
import "./index.scss";
import type { WorkItemRowProps } from "./types";
import { useWorkItemDueDate } from "./useWorkItemDueDate";
import { deriveDisplayId, getDueDateColorClass } from "./utils";

const WorkItemRow: React.FC<WorkItemRowProps> = React.memo(
  ({
    workItem,
    isSelected,
    onSelect,
    onUpdate,
    onDelete,
    onRestore,
    compact = false,
    availableMembers = [],
    availableProjects = [],
    availableMilestones = [],
    availableLabels = [],
    isChecked: isCheckedProp,
    onCheckedChange,
    workItemPrefix,
    showCheckboxes = false,
    externalStatusValue,
    externalStatusOptions,
    onExternalStatusChange,
    statusDisabled = false,
    readonly = false,
    disableProjectEdit = false,
  }) => {
    const { t } = useTranslation("projects");
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      forSessionId: string;
    } | null>(null);
    const [localChecked, setLocalChecked] = useState(false);
    const [savingExternalStatus, setSavingExternalStatus] = useState(false);
    const isChecked = isCheckedProp ?? localChecked;
    const status = workItem.workItemStatus || "backlog";
    const workspaceSource = (
      workItem as typeof workItem & {
        workspaceSource?: { source?: string };
      }
    ).workspaceSource?.source;
    const sourceIntegration = getWorkItemSourceIntegration(
      status,
      workspaceSource
    );
    const priority = workItem.priority || "none";
    const isDeleted = Boolean(workItem.deletedAt);
    const isInteractive = !isDeleted;

    const visibleContextMenu =
      contextMenu && contextMenu.forSessionId === workItem.session_id
        ? { x: contextMenu.x, y: contextMenu.y }
        : null;

    const storedShortId = workItem.shortId || workItem.session_id || "WI-???";
    const projectDisplayId =
      workItemPrefix && !isGitHubIssueStatus(status)
        ? deriveDisplayId(storedShortId, workItemPrefix)
        : storedShortId;
    const shortId =
      formatWorkItemShortId(
        projectDisplayId,
        status,
        workItemPrefix || workItem.project?.name
      ) ?? projectDisplayId;

    const dateInfo = useWorkItemDueDate(workItem.endDate);
    const dueDateColorClass = getDueDateColorClass(status, dateInfo);

    const handleClick = useCallback(() => {
      onSelect(workItem.session_id);
    }, [workItem.session_id, onSelect]);

    const handleRestore = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onRestore?.(workItem.session_id);
      },
      [onRestore, workItem.session_id]
    );

    const handleContextMenu = useCallback(
      (event: React.MouseEvent) => {
        if (readonly || isDeleted) return;
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          forSessionId: workItem.session_id,
        });
      },
      [isDeleted, readonly, workItem.session_id]
    );

    const handleCloseContextMenu = useCallback(() => {
      setContextMenu(null);
    }, []);

    const handleStatusChange = useCallback(
      (newStatus: WorkItemStatus) => {
        onUpdate?.(workItem.session_id, { workItemStatus: newStatus });
      },
      [workItem.session_id, onUpdate]
    );

    const handleExternalStatusChange = useCallback(
      async (statusId: string) => {
        if (!onExternalStatusChange || statusDisabled || savingExternalStatus) {
          return;
        }
        setSavingExternalStatus(true);
        try {
          await onExternalStatusChange(statusId);
        } finally {
          setSavingExternalStatus(false);
        }
      },
      [onExternalStatusChange, savingExternalStatus, statusDisabled]
    );

    const handlePriorityChange = useCallback(
      (newPriority: WorkItemPriority) => {
        onUpdate?.(workItem.session_id, { priority: newPriority });
      },
      [workItem.session_id, onUpdate]
    );

    const handleContextAction = useCallback(
      (action: string, value?: string) => {
        switch (action) {
          case "status":
            if (value) {
              onUpdate?.(workItem.session_id, {
                workItemStatus: value as WorkItemStatus,
              });
            }
            break;
          case "priority":
            if (value) {
              onUpdate?.(workItem.session_id, {
                priority: value as WorkItemPriority,
              });
            }
            break;
          case "delete":
            onDelete?.(workItem.session_id);
            break;
          case "assignee": {
            const assignee = availableMembers.find(
              (member) => member.id === value
            );
            onUpdate?.(workItem.session_id, {
              assignee: value === "none" ? undefined : assignee,
              assigneeType: value === "none" ? undefined : "human",
            });
            break;
          }
          case "lead": {
            const lead = availableMembers.find((member) => member.id === value);
            onUpdate?.(workItem.session_id, {
              lead: value === "none" || !lead ? [] : [lead],
            });
            break;
          }
          case "member": {
            const member = availableMembers.find((item) => item.id === value);
            if (!member) break;
            const members = workItem.members ?? [];
            const exists = members.some((item) => item.id === member.id);
            onUpdate?.(workItem.session_id, {
              members: exists
                ? members.filter((item) => item.id !== member.id)
                : [...members, member],
            });
            break;
          }
          case "label": {
            const label = availableLabels.find((item) => item.id === value);
            if (!label) break;
            const labels = workItem.labels ?? [];
            const exists = labels.some((item) => item.id === label.id);
            onUpdate?.(workItem.session_id, {
              labels: exists
                ? labels.filter((item) => item.id !== label.id)
                : [...labels, label],
            });
            break;
          }
          case "project": {
            const project = availableProjects.find((item) => item.id === value);
            onUpdate?.(workItem.session_id, {
              project: value === "none" ? undefined : project,
            });
            break;
          }
          case "milestone": {
            const milestone = availableMilestones.find(
              (item) => item.id === value
            );
            onUpdate?.(workItem.session_id, {
              milestone: value === "none" ? undefined : milestone,
            });
            break;
          }
          case "labels":
          case "due-date":
          case "rename":
            onSelect(workItem.session_id);
            break;
          default:
            break;
        }
      },
      [
        workItem.session_id,
        workItem.labels,
        workItem.members,
        availableLabels,
        availableMembers,
        availableMilestones,
        availableProjects,
        onUpdate,
        onDelete,
        onSelect,
      ]
    );

    const contextMenuItems = useMemo(() => {
      const items = getContextMenuItems(handleContextAction, t, {
        workItem,
        availableMembers,
        availableProjects,
        availableMilestones,
        availableLabels,
      });
      return onExternalStatusChange
        ? items.filter((item) => item.id !== "status")
        : items;
    }, [
      availableLabels,
      availableMembers,
      availableMilestones,
      availableProjects,
      handleContextAction,
      onExternalStatusChange,
      t,
      workItem,
    ]);

    const handleCheckboxChange = useCallback(
      (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (onCheckedChange) {
          onCheckedChange(workItem.session_id, checked);
        } else {
          setLocalChecked(checked);
        }
      },
      [workItem.session_id, onCheckedChange]
    );

    const handleAssigneeSelect = useCallback(
      (person: Person | null) => {
        onUpdate?.(workItem.session_id, { assignee: person || undefined });
      },
      [workItem.session_id, onUpdate]
    );

    const handleProjectSelect = useCallback(
      (project: WorkItemProject | null) => {
        onUpdate?.(workItem.session_id, { project: project ?? undefined });
      },
      [workItem.session_id, onUpdate]
    );

    const handleDueDateChange = useCallback(
      (date: Date | null) => {
        onUpdate?.(workItem.session_id, {
          endDate: date?.toISOString() || undefined,
        });
      },
      [workItem.session_id, onUpdate]
    );

    return (
      <>
        <div
          data-testid={`work-item-row-${workItem.session_id}`}
          className={`work-item-row group/wiRow flex items-center gap-1 rounded-lg bg-transparent transition-colors ${compact ? "min-h-8 pl-1 pr-2" : "min-h-[40px] pl-2 pr-5"} ${
            isInteractive ? "cursor-pointer hover:bg-fill-1" : "cursor-default"
          } ${isDeleted ? "opacity-70" : ""} ${isSelected ? "bg-primary-1 hover:bg-primary-1" : ""} ${visibleContextMenu ? "bg-fill-2 hover:bg-fill-2" : ""}`}
          onClick={isInteractive ? handleClick : undefined}
          onContextMenu={handleContextMenu}
        >
          <LeadingCells
            shortId={shortId}
            priority={priority}
            status={status}
            isChecked={isChecked}
            showCheckboxes={showCheckboxes}
            onCheckboxChange={handleCheckboxChange}
            onPriorityChange={handlePriorityChange}
            onStatusChange={handleStatusChange}
            externalStatusValue={externalStatusValue}
            externalStatusOptions={externalStatusOptions}
            onExternalStatusChange={handleExternalStatusChange}
            statusDisabled={statusDisabled || savingExternalStatus || isDeleted}
            readonly={readonly || isDeleted}
          />

          {sourceIntegration ? (
            <IntegrationIcon
              type={sourceIntegration}
              size={14}
              className="shrink-0 text-text-2"
            />
          ) : null}

          <TitleCell
            name={workItem.name}
            untitledLabel={t("workItems.untitledWorkItem")}
          />

          <MetadataCells
            workItem={workItem}
            compact={compact}
            availableProjects={availableProjects}
            onProjectSelect={
              disableProjectEdit ? undefined : handleProjectSelect
            }
            readonly={readonly || isDeleted}
            t={t}
          />

          <DueDateCell
            endDate={workItem.endDate}
            formattedDate={dateInfo.formatted}
            colorClass={dueDateColorClass}
            emptyLabel={t("workItems.properties.noDueDate")}
            onDateChange={handleDueDateChange}
            t={t}
            readonly={readonly || isDeleted}
          />

          <AssigneeCell
            workItem={workItem}
            availableMembers={availableMembers}
            onAssigneeSelect={handleAssigneeSelect}
            readonly={readonly || isDeleted}
            t={t}
          />

          {isDeleted && onRestore && (
            <button
              type="button"
              className="ml-2 inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary-6 transition-colors hover:bg-primary-1"
              onClick={handleRestore}
            >
              <RotateCcw size={13} />
              {t("workItems.restore")}
            </button>
          )}
        </div>

        {visibleContextMenu && (
          <WorkItemContextMenu
            items={contextMenuItems}
            position={visibleContextMenu}
            onClose={handleCloseContextMenu}
          />
        )}
      </>
    );
  }
);

WorkItemRow.displayName = "WorkItemRow";

export default WorkItemRow;
