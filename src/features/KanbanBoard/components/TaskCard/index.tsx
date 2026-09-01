/**
 * TaskCard Component
 *
 * Individual task card displayed in Kanban columns.
 * Shows task information with priority, tags, and metadata.
 */
import React from "react";

import AnyIcon from "@src/components/AnyIcon";
import Tag from "@src/components/Tag";
import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  ArrowRight01Icon,
  HugeiconsIcon,
  MessageMultiple01Icon,
} from "@src/icons";
import { formatModelNameFull } from "@src/util/formatModelName";

import { type KanbanTask } from "../../types";
import { PriorityIndicator } from "../../utils/priority";
import { TaskCreatorIdentity } from "../TaskCreator";
import TaskImpactLine from "../TaskImpactLine";
import "./index.scss";
import { formatTaskCardLastUpdated } from "./taskCardTime";

interface TaskCardProps {
  task: KanbanTask;
  onClick?: (task: KanbanTask) => void;
  /**
   * Right-click (secondary click) on the card. Consumers that pass this own
   * the menu — including suppressing the WebView default — so the card only
   * forwards the event.
   */
  onContextMenu?: (task: KanbanTask, event: React.MouseEvent) => void;
  isDragging?: boolean;
  /**
   * True when this card backs the currently-open session preview. Adds
   * a primary-6 accent so the source of the floating panel is obvious.
   */
  isSelected?: boolean;
}

const KANBAN_MONOCHROME_ICON_CLASS = "text-text-1";

function renderAgentIcon(task: KanbanTask) {
  // Session tasks already carry the canonical projection's final icon id.
  // `cliAgentType` remains a compatibility fallback for non-session tasks.
  const agentIconId = task.agentIconId ?? task.cliAgentType;
  const AgentIcon = resolveAgentIcon(agentIconId);
  return (
    <AnyIcon
      icon={AgentIcon}
      // Dynamic icons carry no name of their own; the registry key is the
      // stable identity, and what tests assert on.
      data-icon={agentIconId}
      size={12}
      className={KANBAN_MONOCHROME_ICON_CLASS}
    />
  );
}

const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onClick,
  onContextMenu,
  isDragging,
  isSelected = false,
}) => {
  const handleClick = () => {
    onClick?.(task);
  };

  const handleContextMenu = onContextMenu
    ? (event: React.MouseEvent) => onContextMenu(task, event)
    : undefined;

  const isInteractive = Boolean(onClick);
  const updatedAt = task.updated_at ?? task.completed_at ?? task.created_at;
  const lastUpdatedLabel = task.createdBy
    ? formatTaskCardLastUpdated(updatedAt)
    : "";
  const cardClasses = [
    "kanban-task-card",
    isInteractive && "kanban-task-card--interactive",
    isDragging && "kanban-task-card--dragging",
    isSelected && "kanban-task-card--selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={cardClasses}
      data-testid={`kanban-task-card-${task.id}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Owning Agent Team (only set on the global Kanban board) */}
      {task.orgName && (
        <div className="kanban-task-card__chat-tag">
          <HugeiconsIcon
            icon={MessageMultiple01Icon}
            data-icon="messages-square"
            size={12}
            strokeWidth={1.75}
          />
          <span>{task.orgName}</span>
        </div>
      )}

      {/* Header */}
      <div className="kanban-task-card__header">
        <div className="kanban-task-card__title-row">
          {task.agentLabel && (
            <span
              className="kanban-task-card__agent-icon"
              role="img"
              aria-label={task.agentLabel}
            >
              {renderAgentIcon(task)}
            </span>
          )}
          <div className="kanban-task-card__title">{task.title}</div>
        </div>
        {task.attempt_count && task.attempt_count > 1 && (
          <div className="kanban-task-card__header-badges">
            <div className="kanban-task-card__badge">
              Retry {task.attempt_count - 1}
            </div>
          </div>
        )}
      </div>

      {/* Description */}
      {task.description && (
        <div className="kanban-task-card__description">{task.description}</div>
      )}

      {/* Labels */}
      {task.labels && task.labels.length > 0 && (
        <div className="kanban-task-card__tags">
          {task.labels.slice(0, 3).map((label) => (
            <Tag key={label.id} size="mini" color={label.color} pill>
              {label.name}
            </Tag>
          ))}
          {task.labels.length > 3 && (
            <span className="kanban-task-card__tag-more">
              +{task.labels.length - 3}
            </span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="kanban-task-card__footer">
        <div className="kanban-task-card__footer-left">
          {!task.agentLabel && <TaskImpactLine task={task} />}
          <div className="kanban-task-card__meta-row">
            <PriorityIndicator priority={task.priority} />
            {task.modelName && (
              <div className="kanban-task-card__meta-pill">
                <span>{formatModelNameFull(task.modelName)}</span>
              </div>
            )}
            {task.agentLabel && task.modelName && (
              <span className="kanban-task-card__impact-dot" />
            )}
            {task.agentLabel && <TaskImpactLine task={task} />}
            {task.metaLines?.map((entry, idx) => {
              const Icon = entry.icon;
              return (
                <div
                  key={idx}
                  className="kanban-task-card__meta-pill"
                  style={entry.color ? { color: entry.color } : undefined}
                >
                  {Icon && <AnyIcon icon={Icon} size={12} />}
                  <span>{entry.text}</span>
                </div>
              );
            })}
          </div>
          {task.createdBy && (
            <div className="kanban-task-card__creator-row">
              <TaskCreatorIdentity
                creator={task.createdBy}
                size={12}
                maxNameCharacters={12}
                className="kanban-task-card__creator"
              />
              {lastUpdatedLabel && (
                <>
                  <span className="kanban-task-card__impact-dot" />
                  <span
                    className="kanban-task-card__updated-at"
                    title={updatedAt}
                  >
                    {lastUpdatedLabel}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        {/* Chevron is purely an affordance for "click to open detail" —
         * only render it when there's actually an onClick handler.
         * TodoKanban renders the same card read-only, so the chevron
         * would be misleading there. */}
        {onClick && (
          <div className="kanban-task-card__footer-right">
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={14}
              className="text-text-3"
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskCard;
