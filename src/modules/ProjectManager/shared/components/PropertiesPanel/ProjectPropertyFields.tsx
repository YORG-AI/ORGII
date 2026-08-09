/**
 * ProjectPropertyFields
 *
 * All project-specific property field rows (status, health, priority, lead,
 * members, dates, teams, labels, and completion).
 *
 * Meant to be rendered inside a <PropertiesPanel> shell.
 */
import {
  BriefcaseBusiness,
  Calendar,
  Circle,
  MoreHorizontal,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { type WorkspaceRecord, workspaceApi } from "@src/api/tauri/workspace";
import Button from "@src/components/Button";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
} from "@src/components/PropertyField/PropertyFieldEditable";
import Select, { type SelectOption } from "@src/components/Select";
import { getProjectPropertyContextMenuItems } from "@src/modules/ProjectManager/Projects/projectContextMenu";
import WorkItemContextMenu from "@src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu";
import { DateQuickAssignDropdown } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/DateQuickAssignDropdown";
import type { ContextMenuItem } from "@src/types/core/shared";

import PeopleTeamsLabelsFields from "./PropertyFieldSections/PeopleTeamsLabelsFields";
import StatusHealthPriorityFields from "./PropertyFieldSections/StatusHealthPriorityFields";
import type {
  Label,
  LinkedRepoOption,
  Person,
  ProjectData,
  ProjectHealth,
  ProjectPriority,
  ProjectPropertyFieldKey,
  ProjectStatus,
  Team,
} from "./types";
import { usePropertiesPanel } from "./usePropertiesPanel";

export interface ProjectPropertyFieldsProps {
  project: ProjectData;
  onUpdate?: (updates: Partial<ProjectData>) => void;
  availableMembers?: Person[];
  availableTeams?: Team[];
  availableLabels?: Label[];
  /**
   * Repos that can be linked to the project. Undefined hides the Repos
   * field entirely (e.g. when the host context can't enumerate repos).
   * Empty array still renders the field with an "add repos" empty state.
   */
  availableRepos?: LinkedRepoOption[];
  /** Ref forwarded to PropertiesPanel shell for click-outside detection */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Visual style for property controls. */
  fieldVariant?: FieldRowVariant;
  /** Optional subset of fields rendered directly in the row/panel. */
  visibleFields?: ProjectPropertyFieldKey[];
  /** Render hidden fields behind an ellipsis menu. */
  showMoreMenu?: boolean;
}

export const PROJECT_PROPERTY_CONCISE_FIELDS: ProjectPropertyFieldKey[] = [
  "status",
  "priority",
  "lead",
  "targetDate",
  "linkedRepos",
  "workspace",
];

const DEFAULT_VISIBLE_FIELDS: ProjectPropertyFieldKey[] = [
  "status",
  "health",
  "priority",
  "lead",
  "members",
  "teams",
  "labels",
  "linkedRepos",
  "workspace",
  "startDate",
  "targetDate",
  "completion",
];

function getRepoDisplayName(repo: LinkedRepoOption) {
  const rawName = repo.name || repo.id;
  const parts = rawName.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? rawName;
}

const ProjectPropertyFields: React.FC<ProjectPropertyFieldsProps> = ({
  project,
  onUpdate,
  availableMembers = [],
  availableTeams = [],
  availableLabels = [],
  availableRepos,
  containerRef,
  fieldVariant = "row",
  visibleFields = DEFAULT_VISIBLE_FIELDS,
  showMoreMenu = false,
}) => {
  const {
    t,
    openPicker,
    togglePicker,
    currentStatus,
    currentPriority,
    currentHealth,
    handleStatusChange,
    handlePriorityChange,
    handleHealthChange,
    handleLeadChange,
    handleMemberToggle,
    handleTeamToggle,
    handleLabelToggle,
    handleLinkedRepoToggle,
    handleWorkspaceChange,
    handleDateChange,
    formatDate,
  } = usePropertiesPanel({ project, onUpdate, containerRef });
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void workspaceApi
      .listWorkspaces()
      .then((items) => {
        if (!cancelled) setWorkspaces(items);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const linkedRepoCount = project.linkedRepos?.length ?? 0;
  const linkedRepoLabel =
    linkedRepoCount === 0
      ? t("properties.addRepos")
      : (project.linkedRepos ?? []).map(getRepoDisplayName).join(", ");
  const displayAvailableRepos = useMemo(
    () =>
      availableRepos?.map((repo) => ({
        ...repo,
        name: getRepoDisplayName(repo),
      })),
    [availableRepos]
  );
  const workspaceOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: "",
        label: "Unlinked Workspace",
        triggerLabel: "Unlinked Workspace",
      },
      ...workspaces.map((workspace) => ({
        value: workspace.workspaceId,
        label: workspace.name,
        triggerLabel: workspace.name,
      })),
    ],
    [workspaces]
  );

  const visibleFieldSet = useMemo(
    () => new Set<ProjectPropertyFieldKey>(visibleFields),
    [visibleFields]
  );
  const hiddenFields = useMemo(
    () =>
      DEFAULT_VISIBLE_FIELDS.filter(
        (field) => field !== "completion" && !visibleFieldSet.has(field)
      ) as Exclude<ProjectPropertyFieldKey, "completion">[],
    [visibleFieldSet]
  );
  const [moreMenuPosition, setMoreMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleMoreClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMoreMenuPosition({ x: rect.left, y: rect.bottom + 6 });
  }, []);

  const handleMorePropertyAction = useCallback(
    (field: Exclude<ProjectPropertyFieldKey, "completion">, value?: string) => {
      if (field === "status" && value) {
        handleStatusChange(value as ProjectStatus);
        return;
      }
      if (field === "priority" && value) {
        handlePriorityChange(value as ProjectPriority);
        return;
      }
      if (field === "health" && value) {
        handleHealthChange(value as ProjectHealth);
        return;
      }
      if (field === "lead") {
        handleLeadChange(
          availableMembers.find((member) => member.id === value)
        );
        return;
      }
      if (field === "members" && value) {
        const member = availableMembers.find((item) => item.id === value);
        if (member) handleMemberToggle(member);
        return;
      }
      if (field === "teams" && value) {
        const team = availableTeams.find((item) => item.id === value);
        if (team) handleTeamToggle(team);
        return;
      }
      if (field === "labels" && value) {
        const label = availableLabels.find((item) => item.id === value);
        if (label) handleLabelToggle(label);
        return;
      }
      if (field === "linkedRepos" && value) {
        const repo = displayAvailableRepos?.find((item) => item.id === value);
        if (repo) handleLinkedRepoToggle(repo);
        return;
      }
      if (field === "workspace") {
        handleWorkspaceChange(value || undefined);
        return;
      }
      togglePicker(field);
    },
    [
      availableLabels,
      availableMembers,
      availableTeams,
      displayAvailableRepos,
      handleHealthChange,
      handleLabelToggle,
      handleLeadChange,
      handleLinkedRepoToggle,
      handleMemberToggle,
      handlePriorityChange,
      handleStatusChange,
      handleTeamToggle,
      handleWorkspaceChange,
      togglePicker,
    ]
  );

  const moreMenuItems = useMemo<ContextMenuItem[]>(() => {
    const contextItems = getProjectPropertyContextMenuItems({
      project,
      t,
      onPropertyAction: handleMorePropertyAction,
      availableMembers,
      availableTeams,
      availableLabels,
      availableRepos: displayAvailableRepos,
      propertyFields: hiddenFields,
      includeBaseActions: false,
    });

    return contextItems.flatMap((item) =>
      item.id === "more-properties" ? (item.submenu ?? []) : [item]
    );
  }, [
    availableLabels,
    availableMembers,
    availableTeams,
    displayAvailableRepos,
    handleMorePropertyAction,
    hiddenFields,
    project,
    t,
  ]);

  return (
    <>
      <div
        className={
          fieldVariant === "pill"
            ? "flex flex-nowrap items-center gap-2"
            : "flex flex-col px-2"
        }
      >
        <StatusHealthPriorityFields
          project={project}
          openPicker={openPicker}
          togglePicker={togglePicker}
          currentStatus={currentStatus}
          currentHealth={currentHealth}
          currentPriority={currentPriority}
          handleStatusChange={handleStatusChange}
          handleHealthChange={handleHealthChange}
          handlePriorityChange={handlePriorityChange}
          t={t}
          fieldVariant={fieldVariant}
          visibleFields={visibleFieldSet}
        />

        <PeopleTeamsLabelsFields
          project={project}
          openPicker={openPicker}
          togglePicker={togglePicker}
          availableMembers={availableMembers}
          availableTeams={availableTeams}
          availableLabels={availableLabels}
          availableRepos={displayAvailableRepos}
          handleLeadChange={handleLeadChange}
          handleMemberToggle={handleMemberToggle}
          handleTeamToggle={handleTeamToggle}
          handleLabelToggle={handleLabelToggle}
          handleLinkedRepoToggle={handleLinkedRepoToggle}
          linkedRepoLabel={linkedRepoLabel}
          linkedRepoCount={linkedRepoCount}
          t={t}
          fieldVariant={fieldVariant}
          visibleFields={visibleFieldSet}
        />

        {(visibleFieldSet.has("workspace") || openPicker === "workspace") && (
          <div
            className={
              fieldVariant === "pill"
                ? "relative flex min-h-7 min-w-0 max-w-[240px] items-center"
                : "relative flex min-h-[36px] w-full items-center"
            }
          >
            <FieldRow
              icon={<BriefcaseBusiness size={DROPDOWN_ITEM.iconSize} />}
              label="Workspace"
              value={String(
                workspaceOptions.find(
                  (option) => option.value === (project.workspaceId ?? "")
                )?.triggerLabel ?? "Unlinked Workspace"
              )}
              isSelected={!!project.workspaceId}
              isActive={openPicker === "workspace"}
              variant={fieldVariant}
              onClick={() => togglePicker("workspace")}
            />
            {openPicker === "workspace" && (
              <div
                className="absolute left-0 right-0 top-full z-20 mt-1 min-w-[220px]"
                data-property-dropdown
              >
                <Select
                  value={project.workspaceId ?? ""}
                  options={workspaceOptions}
                  onChange={(value) => {
                    if (!Array.isArray(value)) {
                      handleWorkspaceChange(String(value) || undefined);
                    }
                  }}
                  showSearch
                  dropdownWidthMode="min-match"
                  panelZIndex={10000}
                />
              </div>
            )}
          </div>
        )}

        {/* Start Date */}
        {(visibleFieldSet.has("startDate") || openPicker === "startDate") && (
          <div
            className={
              fieldVariant === "pill"
                ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
                : "relative flex min-h-[36px] w-full items-center"
            }
          >
            <FieldRow
              icon={<Calendar size={DROPDOWN_ITEM.iconSize} />}
              label={t("properties.startDate")}
              value={formatDate(project.startDate)}
              isSelected={!!project.startDate}
              isActive={openPicker === "startDate"}
              variant={fieldVariant}
              onClick={() => togglePicker("startDate")}
            />
            {openPicker === "startDate" && (
              <DateQuickAssignDropdown
                value={project.startDate}
                onChange={(date) => handleDateChange("startDate", date)}
                t={t}
                fieldVariant={fieldVariant}
              />
            )}
          </div>
        )}

        {/* Target Date */}
        {(visibleFieldSet.has("targetDate") || openPicker === "targetDate") && (
          <div
            className={
              fieldVariant === "pill"
                ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
                : "relative flex min-h-[36px] w-full items-center"
            }
          >
            <FieldRow
              icon={<Calendar size={DROPDOWN_ITEM.iconSize} />}
              label={t("properties.targetDate")}
              value={formatDate(project.targetDate)}
              isSelected={!!project.targetDate}
              isActive={openPicker === "targetDate"}
              variant={fieldVariant}
              onClick={() => togglePicker("targetDate")}
            />
            {openPicker === "targetDate" && (
              <DateQuickAssignDropdown
                value={project.targetDate}
                onChange={(date) => handleDateChange("targetDate", date)}
                t={t}
                fieldVariant={fieldVariant}
              />
            )}
          </div>
        )}

        {/* Completion (read-only) */}
        {visibleFieldSet.has("completion") &&
          project.completionPercentage !== undefined && (
            <div
              className={
                fieldVariant === "pill"
                  ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
                  : "relative flex min-h-[36px] w-full items-center"
              }
            >
              <div className="flex min-h-[36px] w-full items-center gap-1 px-2 py-1">
                <span className="w-[72px] shrink-0 text-xs text-text-2">
                  {t("properties.completion")}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1.5">
                  <span
                    className={`${DROPDOWN_ITEM.iconSizeClass} shrink-0 text-primary-6`}
                  >
                    <Circle size={DROPDOWN_ITEM.iconSize} />
                  </span>
                  <span className="flex-1 truncate text-xs text-text-1">
                    {project.completionPercentage}%
                  </span>
                </div>
              </div>
            </div>
          )}

        {showMoreMenu && moreMenuItems.length > 0 && (
          <Button
            variant="secondary"
            appearance="outline"
            size="small"
            shape="round"
            iconOnly
            icon={<MoreHorizontal size={DROPDOWN_ITEM.iconSize} />}
            onClick={handleMoreClick}
            title={t("common:actions.more")}
            htmlType="button"
            className={`!px-3 ${moreMenuPosition ? "!border-primary-5 !bg-primary-1 !text-primary-6" : ""}`}
          />
        )}
      </div>

      {moreMenuPosition && (
        <WorkItemContextMenu
          items={moreMenuItems}
          position={moreMenuPosition}
          onClose={() => setMoreMenuPosition(null)}
        />
      )}
    </>
  );
};

export default ProjectPropertyFields;
