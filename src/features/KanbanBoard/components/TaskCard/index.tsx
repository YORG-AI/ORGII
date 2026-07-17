/**
 * TaskCard Component
 *
 * Individual task card displayed in Kanban columns.
 * Shows task information with priority, tags, and metadata.
 */
import { ChevronRight, MessagesSquare } from "lucide-react";
import React from "react";

import ModelIcon from "@src/components/ModelIcon";
import Tag from "@src/components/Tag";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { formatModelNameFull } from "@src/util/formatModelName";

import { type KanbanTask } from "../../types";
import { PriorityIndicator } from "../../utils/priority";
import TaskImpactLine from "../TaskImpactLine";
import "./index.scss";

export interface TaskCardProps {
  task: KanbanTask;
  onClick?: (task: KanbanTask) => void;
  isDragging?: boolean;
  /**
   * True when this card backs the currently-open session preview. Adds
   * a primary-6 accent so the source of the floating panel is obvious.
   */
  isSelected?: boolean;
}

function renderAgentIcon(task: KanbanTask) {
  if (task.cliAgentType) {
    return <ModelIcon agentType={task.cliAgentType} size={12} />;
  }

  // Cursor IDE history sessions don't carry a `cliAgentType` (they're not
  // launched through our CLI dispatch) but they stamp `agentIconId: "cursor"`
  // in the session loader. Route them through `ModelIcon` so the brand mark
  // matches the Session Creator's hero icon (themeable `text-text-1`) instead
  // of the dim `text-text-3` brand wrapper used for generic Lucide icons.
  if (task.agentIconId === "cursor") {
    return <ModelIcon agentType="cursor_cli" size={12} />;
  }

  const AgentIcon = resolveAgentIcon(task.agentIconId);
  return <AgentIcon size={12} strokeWidth={1.75} className="text-text-3" />;
}

const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onClick,
  isDragging,
  isSelected = false,
}) => {
  const handleClick = () => {
    onClick?.(task);
  };

  const isInteractive = Boolean(onClick);
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
    >
      {/* Owning Agent Team (only set on the global Kanban board) */}
      {task.orgName && (
        <div className="kanban-task-card__chat-tag">
          <MessagesSquare size={12} strokeWidth={1.75} />
          <span>{task.orgName}</span>
        </div>
      )}

      {/* Header */}
      <div className="kanban-task-card__header">
        <div className="kanban-task-card__title">{task.title}</div>
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
          <TaskImpactLine task={task} />
          <div className="kanban-task-card__meta-row">
            <PriorityIndicator priority={task.priority} />
            {task.agentLabel && (
              <div className="kanban-task-card__meta-pill">
                {renderAgentIcon(task)}
                <span>{task.agentLabel}</span>
              </div>
            )}
            {task.agentLabel && task.modelName && (
              <span className="kanban-task-card__impact-dot" />
            )}
            {task.modelName && (
              <div className="kanban-task-card__meta-pill">
                <ModelIcon
                  modelName={task.modelName}
                  agentType={task.cliAgentType}
                  size={12}
                />
                <span>{formatModelNameFull(task.modelName)}</span>
              </div>
            )}
            {task.metaLines?.map((entry, idx) => {
              const Icon = entry.icon;
              return (
                <div
                  key={idx}
                  className="kanban-task-card__meta-pill"
                  style={entry.color ? { color: entry.color } : undefined}
                >
                  {Icon && <Icon size={12} strokeWidth={1.75} />}
                  <span>{entry.text}</span>
                </div>
              );
            })}
          </div>
        </div>
        {/* Chevron is purely an affordance for "click to open detail" —
         * only render it when there's actually an onClick handler.
         * TodoKanban renders the same card read-only, so the chevron
         * would be misleading there. */}
        {onClick && (
          <div className="kanban-task-card__footer-right">
            <ChevronRight size={14} className="text-text-3" />
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskCard;
