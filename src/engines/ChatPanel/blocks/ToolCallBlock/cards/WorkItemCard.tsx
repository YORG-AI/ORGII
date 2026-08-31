import React from "react";

import {
  AlertCircleIcon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleIcon,
  Clock01Icon,
  HugeiconsIcon,
  MinusSignIcon,
} from "@src/icons";

import type {
  WorkItemCardData,
  WorkItemPriority,
  WorkItemStatus,
} from "../types";
import { ToolResultCardFrame } from "./ToolResultCardFrame";

interface StatusConfig {
  icon: React.ReactNode;
  label: string;
  className: string;
}

function getStatusConfig(status: WorkItemStatus | string): StatusConfig {
  switch (status) {
    case "todo":
      return {
        icon: <HugeiconsIcon icon={CircleIcon} data-icon="circle" size={12} />,
        label: "Todo",
        className: "text-text-4",
      };
    case "in_progress":
      return {
        icon: <HugeiconsIcon icon={Clock01Icon} data-icon="clock" size={12} />,
        label: "In Progress",
        className: "text-primary-6",
      };
    case "in_review":
      return {
        icon: (
          <HugeiconsIcon
            icon={AlertCircleIcon}
            data-icon="alert-circle"
            size={12}
          />
        ),
        label: "In Review",
        className: "text-warning-6",
      };
    case "done":
      return {
        icon: (
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            data-icon="check-circle-2"
            size={12}
          />
        ),
        label: "Done",
        className: "text-success-6",
      };
    case "cancelled":
      return {
        icon: (
          <HugeiconsIcon
            icon={CancelCircleIcon}
            data-icon="xcircle"
            size={12}
          />
        ),
        label: "Cancelled",
        className: "text-text-4",
      };
    case "backlog":
      return {
        icon: (
          <HugeiconsIcon
            icon={CircleIcon}
            data-icon="circle"
            size={12}
            className="opacity-40"
          />
        ),
        label: "Backlog",
        className: "text-text-4",
      };
    default:
      return {
        icon: <HugeiconsIcon icon={CircleIcon} data-icon="circle" size={12} />,
        label: String(status),
        className: "text-text-4",
      };
  }
}

interface PriorityConfig {
  icon: React.ReactNode;
  label: string;
  className: string;
}

function getPriorityConfig(
  priority: WorkItemPriority | string
): PriorityConfig {
  switch (priority) {
    case "urgent":
      return {
        icon: (
          <HugeiconsIcon
            icon={AlertCircleIcon}
            data-icon="alert-circle"
            size={11}
          />
        ),
        label: "Urgent",
        className: "text-danger-6",
      };
    case "high":
      return {
        icon: (
          <HugeiconsIcon icon={ArrowUp02Icon} data-icon="arrow-up" size={11} />
        ),
        label: "High",
        className: "text-warning-6",
      };
    case "medium":
      return {
        icon: (
          <HugeiconsIcon icon={MinusSignIcon} data-icon="minus" size={11} />
        ),
        label: "Medium",
        className: "text-text-3",
      };
    case "low":
      return {
        icon: (
          <HugeiconsIcon
            icon={ArrowDown02Icon}
            data-icon="arrow-down"
            size={11}
          />
        ),
        label: "Low",
        className: "text-text-4",
      };
    default:
      return { icon: null, label: String(priority), className: "text-text-4" };
  }
}

interface WorkItemCardProps {
  card: WorkItemCardData;
}

const WorkItemCard: React.FC<WorkItemCardProps> = ({ card }) => {
  const statusConfig = getStatusConfig(card.status);
  const priorityConfig = card.priority
    ? getPriorityConfig(card.priority)
    : null;

  return (
    <ToolResultCardFrame>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 shrink-0 ${statusConfig.className}`}>
          {statusConfig.icon}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="chat-block-content truncate font-medium text-text-1">
              {card.title}
            </span>
            {priorityConfig && (
              <span
                className={`shrink-0 ${priorityConfig.className}`}
                title={priorityConfig.label}
              >
                {priorityConfig.icon}
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-4">
            <span
              className={`inline-flex items-center gap-1 ${statusConfig.className}`}
            >
              {statusConfig.label}
            </span>
            {card.shortId && (
              <>
                <span>·</span>
                <span className="shrink-0">{card.shortId}</span>
              </>
            )}
            {card.projectName && (
              <>
                <span>·</span>
                <span className="truncate">{card.projectName}</span>
              </>
            )}
            {card.assignee && (
              <>
                <span>·</span>
                <span className="shrink-0">{card.assignee}</span>
              </>
            )}
            {card.dueDate && (
              <>
                <span>·</span>
                <span className="shrink-0">Due {card.dueDate}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </ToolResultCardFrame>
  );
};

WorkItemCard.displayName = "WorkItemCard";

export default WorkItemCard;
