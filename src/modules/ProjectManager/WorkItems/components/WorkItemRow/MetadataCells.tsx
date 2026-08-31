import Tag from "@src/components/Tag";
import { HugeiconsIcon, Link02Icon } from "@src/icons";
import type {
  WorkItem as WorkItemExtended,
  WorkItemProject,
} from "@src/types/core/workItem";

import { ProjectCell } from "./ProjectCell";

interface MetadataCellsProps {
  workItem: WorkItemExtended;
  compact: boolean;
  availableProjects: WorkItemProject[];
  onProjectSelect?: (project: WorkItemProject | null) => void;
  readonly?: boolean;
  hideProjectCell?: boolean;
  t: (key: string) => string;
}

export function MetadataCells({
  workItem,
  compact,
  availableProjects,
  onProjectSelect,
  readonly = false,
  hideProjectCell = false,
  t,
}: MetadataCellsProps) {
  return (
    <>
      {!compact && !hideProjectCell && (
        <ProjectCell
          project={workItem.project}
          availableProjects={availableProjects}
          onProjectSelect={onProjectSelect}
          readonly={readonly}
          t={t}
        />
      )}

      <div className="flex shrink flex-wrap items-center gap-1 overflow-hidden">
        {workItem.labels?.map((label) => (
          <Tag key={label.id} size="mini" color={label.color} pill>
            {label.name}
          </Tag>
        ))}
      </div>

      {!compact && (
        <div className="shrink-0">
          {workItem.linkedSessions && workItem.linkedSessions.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-text-3">
              <HugeiconsIcon icon={Link02Icon} data-icon="link-2" size={12} />
              {workItem.linkedSessions.length}
            </span>
          )}
        </div>
      )}

      {!compact && (
        <div className="shrink-0">
          {workItem.subIssueCount !== undefined &&
            workItem.subIssueCount > 0 && (
              <span className="text-xs text-text-3">
                {workItem.subIssueCount}
              </span>
            )}
        </div>
      )}
    </>
  );
}
