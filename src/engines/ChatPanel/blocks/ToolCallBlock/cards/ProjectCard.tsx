import React from "react";

import {
  Calendar01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleIcon,
  Clock01Icon,
  DeliveryBox01Icon,
  FavouriteIcon,
  HugeiconsIcon,
} from "@src/icons";

import type { ProjectCardData, WorkItemStatus } from "../types";
import { ToolResultCardFrame } from "./ToolResultCardFrame";

function getStatusIcon(status: WorkItemStatus | string): React.ReactNode {
  switch (status) {
    case "in_progress":
      return (
        <HugeiconsIcon
          icon={Clock01Icon}
          data-icon="clock"
          size={13}
          className="text-primary-6"
        />
      );
    case "done":
      return (
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          data-icon="check-circle-2"
          size={13}
          className="text-success-6"
        />
      );
    case "cancelled":
      return (
        <HugeiconsIcon
          icon={CancelCircleIcon}
          data-icon="xcircle"
          size={13}
          className="text-text-4"
        />
      );
    default:
      return (
        <HugeiconsIcon
          icon={CircleIcon}
          data-icon="circle"
          size={13}
          className="text-text-4"
        />
      );
  }
}

function getStatusLabel(status: WorkItemStatus | string): string {
  const map: Record<string, string> = {
    todo: "Todo",
    in_progress: "In Progress",
    in_review: "In Review",
    done: "Done",
    cancelled: "Cancelled",
    backlog: "Backlog",
  };
  return map[status] ?? String(status);
}

function getHealthColor(health: string): string {
  switch (health.toLowerCase()) {
    case "on_track":
    case "on track":
      return "text-success-6";
    case "at_risk":
    case "at risk":
      return "text-warning-6";
    case "off_track":
    case "off track":
      return "text-danger-6";
    default:
      return "text-text-4";
  }
}

interface ProjectCardProps {
  card: ProjectCardData;
}

const ProjectCard: React.FC<ProjectCardProps> = ({ card }) => {
  return (
    <ToolResultCardFrame>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-primary-6">
          <HugeiconsIcon icon={DeliveryBox01Icon} data-icon="box" size={13} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="chat-block-content truncate font-medium text-text-1">
              {card.name}
            </span>
            {getStatusIcon(card.status)}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-4">
            <span>{getStatusLabel(card.status)}</span>

            {card.slug && (
              <>
                <span>·</span>
                <span className="truncate font-mono text-[10px]">
                  {card.slug}
                </span>
              </>
            )}

            {card.workItemCount !== undefined && (
              <>
                <span>·</span>
                <span className="shrink-0">
                  {card.workItemCount}{" "}
                  {card.workItemCount === 1 ? "item" : "items"}
                </span>
              </>
            )}

            {card.targetDate && (
              <>
                <span>·</span>
                <span className="inline-flex shrink-0 items-center gap-0.5">
                  <HugeiconsIcon
                    icon={Calendar01Icon}
                    data-icon="calendar"
                    size={10}
                  />
                  {card.targetDate}
                </span>
              </>
            )}

            {card.health && (
              <>
                <span>·</span>
                <span
                  className={`inline-flex shrink-0 items-center gap-0.5 ${getHealthColor(card.health)}`}
                >
                  <HugeiconsIcon
                    icon={FavouriteIcon}
                    data-icon="heart"
                    size={10}
                  />
                  {card.health.replace(/_/g, " ")}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </ToolResultCardFrame>
  );
};

ProjectCard.displayName = "ProjectCard";

export default ProjectCard;
