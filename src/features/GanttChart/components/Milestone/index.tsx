/**
 * GanttMilestone Component
 *
 * Diamond marker for milestones on the timeline.
 */
import React from "react";

import Tooltip from "@src/components/Tooltip";

import type { GanttConfig, GanttMilestone } from "../../types";
import "./index.scss";

interface GanttMilestoneProps {
  milestone: GanttMilestone;
  position: number;
  config: GanttConfig;
  onClick?: (milestone: GanttMilestone) => void;
}

const GanttMilestoneMarker: React.FC<GanttMilestoneProps> = ({
  milestone,
  position,
  onClick,
}) => {
  const getMilestoneColor = (): string => {
    if (milestone.color) return milestone.color;

    switch (milestone.type) {
      case "deadline":
        return "#ef4444"; // Red
      case "release":
        return "#10b981"; // Green
      case "review":
        return "#f59e0b"; // Orange
      case "custom":
        return "#8b5cf6"; // Purple
      default:
        return "#6b7280"; // Gray
    }
  };

  const formatDate = (date: Date | string): string => {
    const dateObj = typeof date === "string" ? new Date(date) : date;
    return dateObj.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getMilestoneIcon = (): string => {
    switch (milestone.type) {
      case "deadline":
        return "!";
      case "release":
        return "✓";
      case "review":
        return "👁";
      case "custom":
        return "◆";
      default:
        return "◆";
    }
  };

  const tooltipContent = (
    <div className="gantt-milestone__tooltip">
      <div className="gantt-milestone__tooltip-title">{milestone.title}</div>
      <div className="gantt-milestone__tooltip-date">
        {formatDate(milestone.date)}
      </div>
      {milestone.description && (
        <div className="gantt-milestone__tooltip-description">
          {milestone.description}
        </div>
      )}
    </div>
  );

  const color = getMilestoneColor();

  return (
    <Tooltip content={tooltipContent} position="top">
      <div
        className="gantt-milestone"
        style={{
          left: position,
          top: 0,
          bottom: 0,
        }}
        onClick={() => onClick?.(milestone)}
      >
        {/* Vertical line */}
        <div
          className="gantt-milestone__line"
          style={{ backgroundColor: color }}
        />

        {/* Diamond marker */}
        <div
          className="gantt-milestone__marker"
          style={{
            backgroundColor: color,
            borderColor: color,
          }}
        >
          <span className="gantt-milestone__icon">{getMilestoneIcon()}</span>
        </div>

        {/* Label */}
        <div className="gantt-milestone__label">{milestone.title}</div>
      </div>
    </Tooltip>
  );
};

export default GanttMilestoneMarker;
