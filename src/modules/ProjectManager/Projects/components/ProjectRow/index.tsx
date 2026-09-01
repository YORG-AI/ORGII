/**
 * ProjectRow Component
 *
 * Individual row for displaying a project in the list view.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import {
  DeliveryBox01Icon,
  HugeiconsIcon,
  ListChecksIcon,
  TimeScheduleIcon,
  Unlink02Icon,
} from "@src/icons";
import WorkItemContextMenu from "@src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu";
import type { Project } from "@src/types/core/project";
import { copyText } from "@src/util/data/clipboard";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import { getProjectContextMenuItems } from "../../projectContextMenu";

const GITHUB_REPOSITORY_PATTERN = /([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/;

function formatGitHubProjectDescription(description?: string) {
  if (!description) return description;
  const repository = description
    .match(GITHUB_REPOSITORY_PATTERN)?.[1]
    .replace(/[.。]+$/, "");
  return repository
    ? `GitHub Issues · ${repository}`
    : description.replace(/[.。]+$/, "");
}

interface ProjectRowProps {
  project: Project;
  isSelected: boolean;
  isChecked?: boolean;
  showCheckboxes?: boolean;
  onSelect: (id: string) => void;
  onCheckedChange?: (id: string, checked: boolean) => void;
  onUnlinkSource?: (project: Project) => void;
  unlinkingSource?: boolean;
  onDelete?: (project: Project) => void;
  readonly?: boolean;
  variant?: "card" | "table";
}

const ProjectRow: React.FC<ProjectRowProps> = ({
  project,
  isSelected,
  isChecked = false,
  showCheckboxes = false,
  onSelect,
  onCheckedChange,
  onUnlinkSource,
  unlinkingSource = false,
  onDelete,
  readonly = false,
  variant = "card",
}) => {
  const { t } = useTranslation("projects");
  const isGitHubSource = project.syncAdapterId === STORY_SYNC_ADAPTER.GITHUB;
  const displayedDescription = isGitHubSource
    ? formatGitHubProjectDescription(project.description)
    : project.description;
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
        onUnlinkSource: onUnlinkSource
          ? () => onUnlinkSource(project)
          : undefined,
        onDelete: onDelete ? () => void handleDelete() : undefined,
      }),
    [handleDelete, onDelete, onSelect, onUnlinkSource, project, t]
  );

  return (
    <>
      <div
        data-testid={`project-row-${project.id}`}
        className={`flex min-h-[40px] items-center gap-1 py-0 pr-5 pl-2 transition-colors ${
          variant === "table"
            ? "rounded-none border-b border-border-1"
            : "rounded-lg"
        } ${
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
              onCheckedChange={handleCheckboxChange}
              size="small"
            />
          </div>

          <div
            className="flex h-7 w-7 items-center justify-center text-text-3"
            data-project-source-icon={isGitHubSource ? "github" : "local"}
          >
            <HugeiconsIcon
              icon={DeliveryBox01Icon}
              data-icon="box"
              size={14}
              strokeWidth={1.75}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="truncate text-[13px] font-medium whitespace-nowrap text-text-1">
            {project.name}
          </span>
          {displayedDescription && (
            <span className="min-w-0 truncate text-xs whitespace-nowrap text-text-3">
              {displayedDescription}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-xs text-text-3">
          {onUnlinkSource && (
            <Button
              variant="tertiary"
              appearance="ghost"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={Unlink02Icon}
                  data-icon="link-2-off"
                  size={13}
                  strokeWidth={1.75}
                />
              }
              iconOnly
              loading={unlinkingSource}
              aria-label={t("settings.sync.adapterPicker.detachProjectAction", {
                project: project.name,
              })}
              title={t("settings.sync.adapterPicker.detachProjectAction", {
                project: project.name,
              })}
              data-testid={`project-unlink-source-${project.id}`}
              onClick={(event) => {
                event.stopPropagation();
                onUnlinkSource(project);
              }}
            />
          )}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <HugeiconsIcon
              icon={ListChecksIcon}
              data-icon="list-checks"
              size={13}
              strokeWidth={1.75}
            />
            {project.workItemCount ?? 0}
          </span>
          {project.targetDate && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <HugeiconsIcon
                icon={TimeScheduleIcon}
                data-icon="calendar-clock"
                size={13}
                strokeWidth={1.75}
              />
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
