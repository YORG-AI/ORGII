/**
 * ProjectRow Component
 *
 * Individual row for displaying a project in the list view.
 */
import { CalendarClock, FolderKanban, ListChecks } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import WorkItemContextMenu from "@src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu";
import type { Project } from "@src/types/core/project";
import { copyText } from "@src/util/data/clipboard";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { getProjectContextMenuItems } from "../../projectContextMenu";

export interface ProjectRowProps {
  project: Project;
  isSelected: boolean;
  isChecked?: boolean;
  showCheckboxes?: boolean;
  onSelect: (id: string) => void;
  onCheckedChange?: (id: string, checked: boolean) => void;
  onDelete?: (project: Project) => void;
  readonly?: boolean;
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  isSelected,
  isChecked = false,
  showCheckboxes = false,
  onSelect,
  onCheckedChange,
  onDelete,
  readonly = false,
}) => {
  const { t } = useTranslation("projects");
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleClick = () => {
    if (readonly) return;
    onSelect(project.id);
  };

  const handleCheckboxChange = useCallback(
    (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => {
      event.stopPropagation();
      onCheckedChange?.(project.id, checked);
    },
    [onCheckedChange, project.id]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (readonly) return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenuPosition({ x: event.clientX, y: event.clientY });
    },
    [readonly]
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenuPosition(null);
  }, []);

  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    const confirmed = await confirmDestructiveAction({
      title: t("common:actions.confirmDeleteTitle", { name: project.name }),
      message: t("common:actions.confirmDeleteMessage"),
      okLabel: t("common:actions.delete"),
      cancelLabel: t("common:actions.cancel"),
    });
    if (confirmed) onDelete(project);
  }, [onDelete, project, t]);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  };

  const contextMenuItems = useMemo(
    () =>
      getProjectContextMenuItems({
        project,
        t,
        onOpen: () => onSelect(project.id),
        onCopy: () => {
          void copyText(project.name);
        },
        onDelete: onDelete ? () => void handleDelete() : undefined,
      }),
    [handleDelete, onDelete, onSelect, project, t]
  );

  return (
    <>
      <div
        data-testid={`project-row-${project.id}`}
        className={`flex min-h-[40px] items-center gap-1 rounded-lg py-0 pl-2 pr-5 transition-colors ${
          readonly
            ? "cursor-default hover:bg-transparent"
            : "group/projectRow cursor-pointer hover:bg-fill-1"
        } ${isSelected || contextMenuPosition ? "bg-fill-2" : ""}`}
        onClick={readonly ? undefined : handleClick}
        onContextMenu={handleContextMenu}
      >
        <div className="grid shrink-0 grid-cols-[1.75rem_1.75rem] items-center gap-1">
          <div
            className={`flex h-7 w-7 items-center justify-center ${
              showCheckboxes
                ? "visible"
                : "invisible group-hover/projectRow:visible"
            }`}
            onClick={(event) => event.stopPropagation()}
          >
            <Checkbox
              checked={isChecked}
              onChange={handleCheckboxChange}
              size="small"
            />
          </div>

          <div className="flex h-7 w-7 items-center justify-center text-text-3">
            <FolderKanban size={14} strokeWidth={1.75} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate whitespace-nowrap text-[13px] font-medium text-text-1">
            {project.name}
          </span>
          {project.description && (
            <span className="min-w-0 truncate whitespace-nowrap text-xs text-text-3">
              {project.description}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-xs text-text-3">
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <ListChecks size={13} strokeWidth={1.75} />
            {project.workItemCount ?? 0}
          </span>
          {project.targetDate && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <CalendarClock size={13} strokeWidth={1.75} />
              {formatDate(project.targetDate)}
            </span>
          )}
        </div>
      </div>

      {contextMenuPosition && (
        <WorkItemContextMenu
          items={contextMenuItems}
          position={contextMenuPosition}
          onClose={handleCloseContextMenu}
        />
      )}
    </>
  );
};

export default ProjectRow;
