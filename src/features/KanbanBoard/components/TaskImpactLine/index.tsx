import { Diff, GitCommit } from "lucide-react";
import React from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";

import type { KanbanTask } from "../../types";
import "./index.scss";

interface TaskImpactLineProps {
  task: KanbanTask;
  className?: string;
  showUnavailable?: boolean;
}

function hasImpact(task: KanbanTask): boolean {
  return Boolean(
    task.impact &&
    (task.impact.filesChanged > 0 ||
      task.impact.linesAdded > 0 ||
      task.impact.linesRemoved > 0 ||
      task.impact.relatedCommits > 0 ||
      task.impact.committedRatePercent > 0)
  );
}

const TaskImpactLine: React.FC<TaskImpactLineProps> = ({
  task,
  className,
  showUnavailable = true,
}) => {
  const relatedCommits = task.impact?.relatedCommits ?? 0;
  const hasRelatedCommits = relatedCommits > 0;
  const rootClassName = ["task-impact-line", className]
    .filter(Boolean)
    .join(" ");

  if (hasImpact(task) && task.impact) {
    return (
      <span className={rootClassName}>
        <DiffStatsBadge
          additions={task.impact.linesAdded}
          deletions={task.impact.linesRemoved}
          variant="plain"
          size="xs"
          className="task-impact-line__diff"
          formatValue={(value) => value.toLocaleString()}
        />
        <span className="task-impact-line__dot" />
        <span className="task-impact-line__item">
          <Diff size={12} strokeWidth={1.75} />
          <span>{task.impact.filesChanged.toLocaleString()}</span>
        </span>
        {hasRelatedCommits && (
          <>
            <span className="task-impact-line__dot" />
            <span className="task-impact-line__item text-primary-6">
              <GitCommit
                className="task-impact-line__commit-icon"
                size={12}
                strokeWidth={1.75}
              />
              <span>{relatedCommits.toLocaleString()}</span>
            </span>
          </>
        )}
      </span>
    );
  }

  if (!showUnavailable) return null;

  return (
    <span className={rootClassName} aria-label="No code changes">
      <span className="task-impact-line__empty" aria-hidden="true">
        —
      </span>
    </span>
  );
};

export default TaskImpactLine;
