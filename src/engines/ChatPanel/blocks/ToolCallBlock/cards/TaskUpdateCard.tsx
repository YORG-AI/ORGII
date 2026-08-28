/**
 * TaskUpdateCard / TaskListCard
 *
 * Both use the standard reusable block primitives — `EventBlockHeader`,
 * `EventBlockHeaderIcon`, title/subtitle/info slots — and `useBlockHeader`
 * for collapse state. Body padding follows `EVENT_SNIPPET_INNER_PADDING_CLASS`
 * (`px-3 py-1.5`) to match every other tool block.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  HugeiconsIcon,
  ListChecksIcon,
  PlayCircleIcon,
  WorkflowCircle05Icon,
} from "@src/icons";

import {
  OrgTaskDependencyBadge,
  OrgTaskMetaRows,
  OrgTaskOwnerChangedBadge,
} from "../../OrgTaskBadges";
import {
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EVENT_SNIPPET_INNER_PADDING_CLASS,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  ExpandableItemList,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "../../primitives";
import { useBlockHeader } from "../../useBlockLocate";
import type { TaskListCardData, TaskUpdateCardData } from "../types";

const TASK_LIST_DEFAULT_VISIBLE = 3;

interface TaskUpdateCardProps {
  card: TaskUpdateCardData;
}

interface TaskListCardProps {
  card: TaskListCardData;
  /**
   * Optional navigate callback — when set, `EventBlockHeader` shows the
   * standard hover ArrowUpRight on the right side. Used by the simulator
   * Messages bubble to jump to the Todo Kanban view; chat-panel callers
   * leave it unset. Ignored when `hideHeader === true`.
   */
  onNavigate?: () => void;
  /**
   * When true, skip the internal `EventBlockHeader` and always render the
   * task list. Used by the simulator Messages app, where the outer chat
   * bubble already provides a verb-phrase header (e.g. "Planner viewed
   * task list"). The task count that normally lives in the header
   * subtitle is rendered as a body meta row instead.
   */
  hideHeader?: boolean;
  /** Optional group-chat sender name merged into the task header title. */
  groupSenderName?: string | null;
}

function TaskDetailRows({ card }: { card: TaskUpdateCardData }) {
  const dependencyText = [...card.blocks, ...card.blockedBy].join(", ");

  return (
    <div className="space-y-1 text-xs text-text-2">
      <div
        className="chat-block-content flex min-w-0 items-center gap-2"
        data-testid="org-task-card-id"
      >
        <HugeiconsIcon
          icon={CircleDotIcon}
          data-icon="circle-dot"
          size={11}
          strokeWidth={1.75}
          className="shrink-0 text-text-3"
        />
        <span className="shrink-0 text-[10px] text-text-3">ID</span>
        <span className="min-w-0 truncate">{card.id}</span>
      </div>

      {card.owner && (
        <div
          className="chat-block-content flex min-w-0 items-center gap-2"
          data-testid="org-task-card-owner"
        >
          <HugeiconsIcon
            icon={CircleDotIcon}
            data-icon="circle-dot"
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <span className="shrink-0 text-[10px] text-text-3">Owner</span>
          <span className="min-w-0 truncate">{card.owner}</span>
        </div>
      )}

      {card.activeForm && (
        <div
          className="chat-block-content flex min-w-0 items-center gap-2"
          data-testid="org-task-card-active"
        >
          <HugeiconsIcon
            icon={ListChecksIcon}
            data-icon="list-checks"
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <span className="shrink-0 text-[10px] text-text-3">Active</span>
          <span className="min-w-0 truncate">{card.activeForm}</span>
        </div>
      )}

      {card.blocks.length > 0 && (
        <div
          className="chat-block-content flex min-w-0 items-center gap-2"
          data-testid="org-task-card-blocks"
        >
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <span className="shrink-0 text-[10px] text-text-3">Blocks</span>
          <span className="min-w-0 truncate">{card.blocks.join(", ")}</span>
        </div>
      )}

      {card.blockedBy.length > 0 && (
        <div
          className="chat-block-content flex min-w-0 items-center gap-2"
          data-testid="org-task-card-blocked-by"
        >
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <span className="shrink-0 text-[10px] text-text-3">Blocked by</span>
          <span className="min-w-0 truncate">{card.blockedBy.join(", ")}</span>
        </div>
      )}

      {dependencyText && <span className="sr-only">{dependencyText}</span>}
    </div>
  );
}

function TaskStatusBadges({ card }: { card: TaskUpdateCardData }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {card.status && (
        <span
          className="shrink-0 rounded-full bg-fill-3 px-1.5 py-0.5 text-[10px] text-text-2"
          data-testid="org-task-card-status"
        >
          {card.status}
        </span>
      )}
      {card.ownerChanged && (
        <span
          className="shrink-0 text-[10px] text-primary-6"
          data-testid="org-task-card-owner-changed"
        >
          owner changed
        </span>
      )}
      {card.taskAssignedDispatched && (
        <span
          className="inline-flex shrink-0 items-center gap-1 text-[10px] text-success-6"
          data-testid="org-task-card-assigned"
        >
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            data-icon="check-circle-2"
            size={10}
          />{" "}
          assigned
        </span>
      )}
    </span>
  );
}

const TaskUpdateCard: React.FC<TaskUpdateCardProps> = ({ card }) => {
  const { t } = useTranslation("sessions");
  const title = card.subject ?? card.activeForm ?? card.id;
  const headerTitle =
    card.action === "created"
      ? t("orgTask.create.title", { title })
      : t("orgTask.update.title", { title });

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({ defaultCollapsed: true });

  return (
    <div
      className={getEventBlockContainerClasses(true)}
      data-testid="org-task-card"
    >
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover
        onClick={handleHeaderClick}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={<TaskStatusBadges card={card} />}
      >
        <EventBlockHeaderIcon
          icon={getToolIcon(
            card.action === "created" ? "task_create" : "task_update",
            { size: SESSION_UI_TOKENS.ICON.SIZE_SM }
          )}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent
        />
        <EventBlockHeaderTitle>{headerTitle}</EventBlockHeaderTitle>
      </EventBlockHeader>

      {!isCollapsed && (
        <div
          className={`border-t border-border-1 ${EVENT_SNIPPET_INNER_PADDING_CLASS}`}
        >
          <TaskDetailRows card={card} />
        </div>
      )}
    </div>
  );
};

function getListRowStatusIcon(status?: string): React.ReactNode {
  if (!status) return null;
  if (status === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        data-icon="check-circle-2"
        size={13}
        strokeWidth={2}
        className="shrink-0 text-success-6"
      />
    );
  }
  if (status === "in_progress") {
    return (
      <HugeiconsIcon
        icon={PlayCircleIcon}
        data-icon="play-circle"
        size={13}
        strokeWidth={2}
        className="shrink-0 text-primary-6"
      />
    );
  }
  if (status === "pending") {
    return (
      <HugeiconsIcon
        icon={CircleDotIcon}
        data-icon="circle-dot"
        size={13}
        strokeWidth={2}
        className="shrink-0 text-text-3"
      />
    );
  }
  return null;
}

function TaskListRow({ task }: { task: TaskUpdateCardData }) {
  const { t } = useTranslation("sessions");
  const title = task.subject ?? task.activeForm ?? task.id;
  const statusLabel = task.status
    ? t(`orgTask.status.${task.status}`, { defaultValue: task.status })
    : null;
  const assignedLabel = task.taskAssignedDispatched
    ? t("orgTask.assignedBadge", { defaultValue: "Assigned" })
    : null;
  const statusRowLabel = [assignedLabel, statusLabel]
    .filter(Boolean)
    .join(" · ");
  const dependencyCount = task.blocks.length + task.blockedBy.length;
  const hasMetaRows = Boolean(task.owner || statusRowLabel);

  return (
    <div data-testid="org-task-list-card-row" data-task-id={task.id}>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {getListRowStatusIcon(task.status)}
        <span className="min-w-0 flex-1 truncate" title={title}>
          {title}
        </span>
        {task.ownerChanged && <OrgTaskOwnerChangedBadge />}
        <OrgTaskDependencyBadge count={dependencyCount} />
      </div>

      {hasMetaRows && (
        <OrgTaskMetaRows>
          {task.owner && (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="org-task-list-row-assigned-to"
            >
              <span className="shrink-0 text-text-3">
                {t("orgTask.assignedToLabel")}
              </span>
              <span className="min-w-0 truncate text-text-1" title={task.owner}>
                {task.owner}
              </span>
            </div>
          )}
          {statusRowLabel && (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="org-task-list-row-status"
            >
              <span className="shrink-0 text-text-3">
                {t("orgTask.statusLabel")}
              </span>
              <span
                className="min-w-0 truncate text-text-1"
                data-testid="org-task-card-status"
              >
                {statusRowLabel}
              </span>
            </div>
          )}
        </OrgTaskMetaRows>
      )}
    </div>
  );
}

export const TaskListCard: React.FC<TaskListCardProps> = ({
  card,
  onNavigate,
  hideHeader = false,
  groupSenderName = null,
}) => {
  const { t } = useTranslation("sessions");
  const count = card.total ?? card.tasks.length;
  const title =
    groupSenderName != null
      ? card.kind === "get"
        ? t("groupChat.taskHeader.get", {
            sender: groupSenderName,
            defaultValue: "{{sender}} viewed task details",
          })
        : card.kind === "graph"
          ? t("groupChat.taskHeader.create", {
              sender: groupSenderName,
              defaultValue: "{{sender}} assigned tasks",
            })
          : t("groupChat.taskHeader.list", {
              sender: groupSenderName,
              defaultValue: "{{sender}} viewed task list",
            })
      : card.kind === "get"
        ? t("orgTask.get.title")
        : card.kind === "graph"
          ? t("orgTask.create.title")
          : t("orgTask.list.title");
  const subtitle = t("orgTask.list.count", { taskCount: count });
  const taskListIcon = getToolIcon(
    card.kind === "get"
      ? "task_get"
      : card.kind === "graph"
        ? "task_graph_create"
        : "task_list",
    {
      size: SESSION_UI_TOKENS.ICON.SIZE_SM,
    }
  );

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({ defaultCollapsed: true });

  const listBody =
    card.tasks.length === 0 ? (
      <div
        className={`text-xs text-text-3 ${EVENT_SNIPPET_INNER_PADDING_CLASS}`}
      >
        {t("orgTask.list.empty")}
      </div>
    ) : (
      <ExpandableItemList<TaskUpdateCardData>
        items={card.tasks}
        getKey={(task) => task.id}
        visibleCount={TASK_LIST_DEFAULT_VISIBLE}
        className="flex flex-col divide-y divide-border-1 px-3"
        withBorder={false}
        renderItem={(task) => (
          <div className="py-2">
            <TaskListRow task={task} />
          </div>
        )}
      />
    );

  // Header-less variant (simulator Messages app): show a count meta row
  // (since the subtitle in the chat-panel header would normally carry it)
  // followed by the task list, inside a self-contained block.
  if (hideHeader) {
    return (
      <div
        className={`${getEventBlockContainerClasses(true)} animate-fade-in overflow-hidden`}
        data-testid="org-task-list-card"
        data-task-card-kind={card.kind}
      >
        <div className="border-b border-border-1 px-3 py-1.5 text-[13px] leading-normal">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-text-3">
              {t("orgTask.list.countLabel", { defaultValue: "Tasks" })}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-text-1"
              title={subtitle}
            >
              {count}
            </span>
          </div>
        </div>
        <div data-testid="org-task-list-card-body">{listBody}</div>
      </div>
    );
  }

  return (
    <div
      className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
      data-testid="org-task-list-card"
      data-task-card-kind={card.kind}
    >
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={handleHeaderClick}
        onNavigate={onNavigate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={taskListIcon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent
        />
        <EventBlockHeaderTitle>{title}</EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle title={subtitle}>
          {subtitle}
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>

      {!isCollapsed && (
        <div
          className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in`}
          data-testid="org-task-list-card-body"
        >
          {listBody}
        </div>
      )}
    </div>
  );
};

TaskUpdateCard.displayName = "TaskUpdateCard";
TaskListCard.displayName = "TaskListCard";

export default TaskUpdateCard;
