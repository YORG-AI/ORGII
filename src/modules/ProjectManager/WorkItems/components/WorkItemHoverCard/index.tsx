/** Hover-card presentation owned by Project Manager work items. */
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "@src/components/SessionHoverCard/HoverCardBase";
import {
  Building02Icon,
  Clock01Icon,
  Flag01Icon,
  FolderKanbanIcon,
  GitCommitVerticalIcon,
  HugeiconsIcon,
  TagsIcon,
  UserIcon,
} from "@src/icons";
import {
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
  getWorkItemPriorityConfig,
  getWorkItemStatusConfig,
} from "@src/modules/ProjectManager/config/manage";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

export interface WorkItemHoverCardData {
  id: string;
  title: string;
  status: string;
  priority: string;
  projectName?: string;
  orgName?: string;
  source: "local" | "linear";
  assignee?: { name: string } | null;
  labels?: readonly { name: string }[];
  createdAt?: string;
  updatedAt?: string;
}

interface WorkItemHoverCardProps {
  workItem?: WorkItemHoverCardData | null;
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
}

interface WorkItemHoverCardContentProps {
  workItem: WorkItemHoverCardData;
}

function isWorkItemStatus(value: string): value is WorkItemStatus {
  return WORK_ITEM_STATUS_OPTIONS.some((option) => option.value === value);
}

function isWorkItemPriority(value: string): value is WorkItemPriority {
  return WORK_ITEM_PRIORITY_OPTIONS.some((option) => option.value === value);
}

function WorkItemStatusRow({ status }: { status: string }) {
  const { t } = useTranslation("projects");
  if (!isWorkItemStatus(status)) return null;

  const config = getWorkItemStatusConfig(status);
  return (
    <HoverCardRow icon={config.icon} iconClassName="text-text-3">
      <div className="truncate text-text-2" style={{ color: config.color }}>
        {t(`workItems.statusLabels.${status}`)}
      </div>
    </HoverCardRow>
  );
}

function WorkItemPriorityRow({ priority }: { priority: string }) {
  const { t } = useTranslation("projects");
  if (!isWorkItemPriority(priority)) return null;

  const config = getWorkItemPriorityConfig(priority);
  return (
    <HoverCardRow
      icon={
        config.icon ?? (
          <HugeiconsIcon
            icon={Flag01Icon}
            data-icon="flag"
            size={13}
            strokeWidth={1.75}
          />
        )
      }
      iconClassName="text-text-3"
    >
      <div className="truncate text-text-2" style={{ color: config.color }}>
        {t(`workItems.priorityLabels.${priority}`)}
      </div>
    </HoverCardRow>
  );
}

const WorkItemHoverCardContent: React.FC<WorkItemHoverCardContentProps> = memo(
  ({ workItem }) => {
    const { t, i18n } = useTranslation(["projects", "sessions", "common"]);
    const dateTimeLabelOptions = {
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.language),
      monthStyle: "short" as const,
      withSeconds: false,
    };

    const title = workItem.title || t("projects:workItems.untitledWorkItem");
    const createdLabel =
      workItem.source === "local"
        ? formatReplayDateLabel(workItem.createdAt, dateTimeLabelOptions)
        : "";
    const updatedLabel =
      workItem.source === "local"
        ? formatReplayDateLabel(workItem.updatedAt, dateTimeLabelOptions)
        : "";
    const labels = workItem.source === "local" ? (workItem.labels ?? []) : [];
    const labelsTitle = labels.map((label) => label.name).join(", ");

    return (
      <HoverCardPanel title={title}>
        <WorkItemStatusRow status={workItem.status} />
        <WorkItemPriorityRow priority={workItem.priority} />
        {workItem.projectName && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={FolderKanbanIcon}
                data-icon="folder-kanban"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">{workItem.projectName}</div>
          </HoverCardRow>
        )}
        {workItem.orgName && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={Building02Icon}
                data-icon="building-2"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">{workItem.orgName}</div>
          </HoverCardRow>
        )}
        {workItem.source === "local" && workItem.assignee && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={UserIcon}
                data-icon="user"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">{workItem.assignee.name}</div>
          </HoverCardRow>
        )}
        {labels.length > 0 && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={TagsIcon}
                data-icon="tags"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2" title={labelsTitle}>
              {labelsTitle}
            </div>
          </HoverCardRow>
        )}
        {createdLabel && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={Clock01Icon}
                data-icon="clock"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2" title={createdLabel}>
              <span className="text-text-3">
                {t("sessions:history.detail.created")}
              </span>
              <span className="mx-1 text-text-4">·</span>
              <span>{createdLabel}</span>
            </div>
          </HoverCardRow>
        )}
        {updatedLabel && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={GitCommitVerticalIcon}
                data-icon="git-commit-vertical"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2" title={updatedLabel}>
              <span className="text-text-3">
                {t("sessions:history.detail.lastUpdated")}
              </span>
              <span className="mx-1 text-text-4">·</span>
              <span>{updatedLabel}</span>
            </div>
          </HoverCardRow>
        )}
      </HoverCardPanel>
    );
  }
);

WorkItemHoverCardContent.displayName = "WorkItemHoverCardContent";

const WorkItemHoverCard: React.FC<WorkItemHoverCardProps> = ({
  workItem,
  children,
  position,
  mouseEnterDelay,
  mouseLeaveDelay,
}) => {
  const renderContent = useCallback(
    () => (workItem ? <WorkItemHoverCardContent workItem={workItem} /> : null),
    [workItem]
  );

  return (
    <HoverCardBase
      cardId={workItem ? `${workItem.source}:${workItem.id}` : null}
      position={position}
      mouseEnterDelay={mouseEnterDelay}
      mouseLeaveDelay={mouseLeaveDelay}
      renderContent={renderContent}
    >
      {children}
    </HoverCardBase>
  );
};

export default WorkItemHoverCard;
