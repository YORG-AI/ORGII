/**
 * OrgTaskBlock — Compact task card for AgentOrg task_create / task_update events.
 *
 * Shown in the chat stream when a coordinator agent creates a new task and
 * assigns it to a member, or updates an existing task's owner / status.
 * Reuses TaskCard's CSS class names and KanbanBoard utilities for visual
 * consistency with the Kanban board.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import InlineAlert from "@src/components/InlineAlert";
import { getToolIconComponent } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import type { ResolvedOrgTaskOperationOutcome } from "@src/engines/SessionCore/rendering/orgTaskOutcome";
import { PriorityIndicator } from "@src/features/KanbanBoard/utils/priority";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  HugeiconsIcon,
  PlayCircleIcon,
} from "@src/icons";
import { formatSmartDateTime } from "@src/util/data/formatters/date";

import {
  OrgTaskDependencyBadge,
  OrgTaskMetaRows,
  OrgTaskOwnerChangedBadge,
} from "../OrgTaskBadges";
import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

// ============================================
// Types
// ============================================

export type OrgTaskAction = "create" | "update" | "delete";

interface OrgTaskBlockProps {
  action: OrgTaskAction;
  title: string;
  description?: string;
  ownerName?: string;
  status?: string;
  priority?: string;
  blocks?: string[];
  blockedBy?: string[];
  ownerChanged?: boolean;
  /**
   * For `action === "update"`: true when the task's `status` field was
   * mutated by this event. Drives the header copy ("Update task status"
   * vs "Update task detail") and the "Marked as ..." subtitle. Ignored
   * when `action !== "update"`.
   */
  statusChanged?: boolean;
  taskAssignedDispatched?: boolean;
  operationOutcome?: ResolvedOrgTaskOperationOutcome;
  operationMessage?: string;
  isLoading?: boolean;
  eventId?: string;
  /** ISO timestamp of the underlying event; shown at the right end of the header. */
  timestamp?: string;
  /**
   * When true, skip the internal `EventBlockHeader` entirely and always
   * render the task body. Used by the simulator Messages app, where the
   * outer chat bubble already provides a sender header + verb phrase
   * (e.g. "Planner updated task") and a second internal header would be
   * redundant. Chat-panel callers leave this `false` (default).
   */
  hideHeader?: boolean;
  /** Optional group-chat sender name merged into the task header title. */
  groupSenderName?: string | null;
  toolUsage?: ToolUsageMetadata;
}

// ============================================
// Helpers
// ============================================

/**
 * Resolve the header icon from the Rust tool registry (`task_create`
 * → `clipboard-copy`, `task_update` → `clipboard-pen`). Keeping this in
 * sync with Rust `icon_id` per the frontend ↔ backend alignment rule —
 * we deliberately do not hardcode glyph bindings here.
 */
function getActionIcon(action: OrgTaskAction) {
  const toolName = action === "create" ? "task_create" : "task_update";
  const icon = getToolIconComponent(toolName);
  return (
    <AnyIcon icon={icon} size={14} strokeWidth={1.75} className="text-text-2" />
  );
}

/**
 * Title-row status indicator: maps the task's lifecycle status to a 13px
 * Icon glyph + color matching the existing AgentOrgTaskList chip palette.
 * Returns `null` for unknown / missing status so the icon slot collapses
 * silently. The "blocked" derived state is intentionally not handled here
 * — `OrgTaskBlock` only sees a single task's `blocks` / `blockedBy` ids,
 * not whether those blocker tasks have completed, so blocked detection
 * lives in the Overview panel (which holds the full task graph) until
 * Rust exposes a `blocked: bool` flag on the extracted payload.
 */
function getStatusIcon(status?: string): React.ReactNode {
  if (!status) return null;
  if (status === "completed") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        data-icon="check-circle-2"
        size={13}
        strokeWidth={2}
        className="shrink-0 text-success-6"
        data-testid="org-task-card-status-icon"
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
        data-testid="org-task-card-status-icon"
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
        data-testid="org-task-card-status-icon"
      />
    );
  }
  return null;
}

// ============================================
// Compact inline task card (no drag, no click)
// ============================================

function CompactTaskCard({
  title,
  description,
  ownerName,
  status,
  priority,
  blocks = [],
  blockedBy = [],
  ownerChanged,
  taskAssignedDispatched,
  operationOutcome = "succeeded",
  operationMessage,
  formattedTimestamp,
  timestamp,
  hideAssignedRow = false,
}: {
  title: string;
  description?: string;
  ownerName?: string;
  status?: string;
  priority?: string;
  blocks?: string[];
  blockedBy?: string[];
  ownerChanged?: boolean;
  taskAssignedDispatched?: boolean;
  operationOutcome?: ResolvedOrgTaskOperationOutcome;
  operationMessage?: string;
  formattedTimestamp?: string | null;
  timestamp?: string;
  /**
   * When true, suppress the "Assigned to {ownerName}" meta row in the body.
   * Used by `action === "create"` cards where the owner is already shown in
   * the header title ("Assign task to {ownerName}"), so repeating it in the
   * body would be redundant.
   */
  hideAssignedRow?: boolean;
}) {
  const { t } = useTranslation("sessions");

  const operationAccepted = operationOutcome === "succeeded";
  const statusLabel =
    operationAccepted && status
      ? t(`orgTask.status.${status}`, { defaultValue: status })
      : null;
  const assignedLabel =
    operationAccepted && taskAssignedDispatched
      ? t("orgTask.assignedBadge", { defaultValue: "Assigned" })
      : null;
  const outcomeLabel = operationAccepted
    ? null
    : t(`orgTask.outcome.${operationOutcome}`, {
        defaultValue: operationOutcome,
      });
  const statusRowLabel =
    outcomeLabel ?? [assignedLabel, statusLabel].filter(Boolean).join(" · ");
  const dependencyCount = blocks.length + blockedBy.length;

  const showAssignedRow =
    operationAccepted && Boolean(ownerName) && !hideAssignedRow;
  const hasMetaRows = Boolean(
    showAssignedRow || formattedTimestamp || statusRowLabel
  );

  return (
    <div className="org-task-block__card" data-testid="org-task-card">
      {/* Title row — leading status icon + title + badges (owner-changed / deps); assigned + status merged into meta rows below */}
      <div className="kanban-task-card__header mb-0">
        <div className="kanban-task-card__title flex min-w-0 items-center gap-1.5 text-[13px]">
          {operationAccepted ? getStatusIcon(status) : null}
          <span className="min-w-0 truncate">{title}</span>
        </div>
        {ownerChanged && <OrgTaskOwnerChangedBadge />}
        <OrgTaskDependencyBadge count={dependencyCount} />
      </div>

      {/* Description */}
      {description && (
        <div className="kanban-task-card__description mt-1 text-[11px]">
          {description}
        </div>
      )}

      {!operationAccepted && (
        <InlineAlert
          type={
            operationOutcome === "failed"
              ? "danger"
              : operationOutcome === "rejected"
                ? "warning"
                : "info"
          }
          title={outcomeLabel ?? undefined}
          className="mt-2"
        >
          {operationMessage}
        </InlineAlert>
      )}

      {/* Meta rows: Assigned to / Updated at / Status — inline with vertical separators when there is room, wraps to multiple lines otherwise. */}
      {hasMetaRows && (
        <OrgTaskMetaRows>
          {showAssignedRow && (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="org-task-block-assigned-to"
            >
              <span className="shrink-0 text-text-3">
                {t("orgTask.assignedToLabel")}
              </span>
              <span className="min-w-0 truncate text-text-1" title={ownerName}>
                {ownerName}
              </span>
              {priority && (
                <span className="shrink-0">
                  <PriorityIndicator priority={priority} />
                </span>
              )}
            </div>
          )}
          {statusRowLabel && (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="org-task-block-status"
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
          {formattedTimestamp && (
            <div
              className="flex min-w-0 items-center gap-2"
              data-testid="org-task-block-updated-at"
            >
              <span className="shrink-0 text-text-3">
                {t("orgTask.updatedAtLabel")}
              </span>
              <span
                className="min-w-0 truncate text-text-1 tabular-nums"
                title={timestamp}
                data-testid="org-task-block-timestamp"
              >
                {formattedTimestamp}
              </span>
            </div>
          )}
        </OrgTaskMetaRows>
      )}
    </div>
  );
}

// ============================================
// Main Block
// ============================================

const OrgTaskBlock: React.FC<OrgTaskBlockProps> = ({
  action,
  title,
  description,
  ownerName,
  status,
  priority,
  blocks = [],
  blockedBy = [],
  ownerChanged,
  statusChanged,
  taskAssignedDispatched,
  operationOutcome = "succeeded",
  operationMessage,
  isLoading = false,
  eventId,
  timestamp,
  hideHeader = false,
  groupSenderName = null,
  toolUsage,
}) => {
  const { t } = useTranslation("sessions");
  const yesterdayLabel = t("common:relativeDate.yesterday", {
    defaultValue: "Yesterday",
  });
  const formattedTimestamp = timestamp
    ? formatSmartDateTime(timestamp, { yesterdayLabel })
    : null;

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleLocate,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: false,
    eventId,
    collapseAllValue: true,
  });

  const icon = getActionIcon(action);

  // Header title:
  // - create: "Assign task to {ownerName}" if owner known, else generic.
  // - update: split into "status" vs "detail" so the user can tell at a
  //   glance whether this row is just a lifecycle tick (pending → in_progress
  //   → completed) or a content edit (title / description / owner / deps).
  const updateChangeKind: "status" | "detail" = statusChanged
    ? "status"
    : "detail";
  const operationHeaderTitle =
    operationOutcome === "succeeded"
      ? null
      : groupSenderName != null
        ? t(
            `groupChat.taskHeader.${action}${operationOutcome === "pending" ? "Running" : operationOutcome === "rejected" ? "Rejected" : "Failed"}`,
            {
              sender: groupSenderName,
              defaultValue:
                operationOutcome === "pending"
                  ? "{{sender}} is working on a task operation"
                  : operationOutcome === "rejected"
                    ? "{{sender}}'s task operation needs correction"
                    : "{{sender}}'s task operation failed",
            }
          )
        : t(
            `orgTask.${action}.${operationOutcome === "pending" ? "runningTitle" : operationOutcome === "rejected" ? "rejectedTitle" : "failedTitle"}`,
            {
              defaultValue:
                operationOutcome === "pending"
                  ? "Working on task operation"
                  : operationOutcome === "rejected"
                    ? "Task operation needs correction"
                    : "Task operation failed",
            }
          );
  const headerTitle =
    operationHeaderTitle ??
    (groupSenderName != null
      ? action === "create"
        ? ownerName
          ? t("groupChat.taskHeader.createWithOwner", {
              sender: groupSenderName,
              ownerName,
              defaultValue: "{{sender}} assigned task to {{ownerName}}",
            })
          : t("groupChat.taskHeader.create", {
              sender: groupSenderName,
              defaultValue: "{{sender}} assigned task",
            })
        : action === "delete"
          ? t("simulator.replay.messages.bubble.senderTitle.taskDeleted", {
              subject: groupSenderName,
              defaultValue: "{{subject}} deleted task",
            })
          : updateChangeKind === "status"
            ? t("groupChat.taskHeader.updateStatus", {
                sender: groupSenderName,
                defaultValue: "{{sender}} updated task status",
              })
            : t("groupChat.taskHeader.updateDetail", {
                sender: groupSenderName,
                defaultValue: "{{sender}} updated task detail",
              })
      : action === "create"
        ? ownerName
          ? t("orgTask.create.titleWithOwner", {
              ownerName,
              defaultValue: "Assign task to {{ownerName}}",
            })
          : t("orgTask.create.title")
        : action === "delete"
          ? t("tools.deleted", { defaultValue: "Deleted task" })
          : updateChangeKind === "status"
            ? t("orgTask.update.titleStatus", {
                defaultValue: "Update task status",
              })
            : t("orgTask.update.titleDetail", {
                defaultValue: "Update task detail",
              }));

  // Subtitle: only populated when action is "update" + status changed.
  // Reads "Marked as [Pending|In Progress|Completed]" using the same
  // localized status label as the body chip. For create / detail updates
  // the card body's title row already conveys the change.
  const statusLabel =
    operationOutcome === "succeeded" && status
      ? t(`orgTask.status.${status}`, { defaultValue: status })
      : null;
  const headerSubtitle =
    action === "update" && statusChanged && statusLabel
      ? t("orgTask.update.markedAs", {
          status: statusLabel,
          defaultValue: "Marked as {{status}}",
        })
      : null;

  const hasContent = Boolean(
    title ||
    description ||
    ownerName ||
    status ||
    blocks.length > 0 ||
    blockedBy.length > 0 ||
    operationOutcome !== "succeeded" ||
    operationMessage
  );

  // Header-less variant (simulator Messages app): drop the EventBlockHeader
  // and the transparent shell wrapper — render the task body directly so
  // the chat bubble owns the title row.
  if (hideHeader) {
    if (!hasContent) return null;
    return (
      <div
        className={`${getEventBlockContainerClasses(true)} animate-fade-in p-3`}
      >
        <CompactTaskCard
          title={title}
          description={description}
          ownerName={ownerName}
          status={status}
          priority={priority}
          blocks={blocks}
          blockedBy={blockedBy}
          ownerChanged={ownerChanged}
          taskAssignedDispatched={taskAssignedDispatched}
          operationOutcome={operationOutcome}
          operationMessage={operationMessage}
          formattedTimestamp={formattedTimestamp}
          timestamp={timestamp}
          hideAssignedRow={
            action === "create" ||
            action === "delete" ||
            operationOutcome !== "succeeded"
          }
        />
      </div>
    );
  }

  return (
    <div className={`${getEventBlockContainerClasses(false)} animate-fade-in`}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={handleLocate}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={
          toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
        }
      >
        <EventBlockHeaderIcon
          icon={icon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={hasContent ? handleHeaderClick : undefined}
          hasContent={hasContent}
          revealChevronOnIconHoverOnly={Boolean(eventId)}
          isLoading={isLoading}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {headerTitle}
        </EventBlockHeaderTitle>
        {headerSubtitle && (
          <EventBlockHeaderSubtitle
            isLoading={isLoading}
            title={headerSubtitle}
          >
            {headerSubtitle}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {!isCollapsed && hasContent && (
        <div
          className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in p-3`}
        >
          <CompactTaskCard
            title={title}
            description={description}
            ownerName={ownerName}
            status={status}
            priority={priority}
            blocks={blocks}
            blockedBy={blockedBy}
            ownerChanged={ownerChanged}
            taskAssignedDispatched={taskAssignedDispatched}
            operationOutcome={operationOutcome}
            operationMessage={operationMessage}
            formattedTimestamp={formattedTimestamp}
            timestamp={timestamp}
            hideAssignedRow={
              action === "create" ||
              action === "delete" ||
              operationOutcome !== "succeeded"
            }
          />
        </div>
      )}
    </div>
  );
};

OrgTaskBlock.displayName = "OrgTaskBlock";

export default OrgTaskBlock;
