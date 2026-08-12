/**
 * ProjectPropertyFields
 *
 * All project-specific property field rows (status, health, priority, lead,
 * members, dates, teams, labels, and completion).
 *
 * Meant to be rendered inside a <PropertiesPanel> shell.
 */
import { Calendar, Circle, ListChevronsUpDown } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";

import Button from "@src/components/Button";
import { pillControlStateClass } from "@src/components/CompoundPill/config";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { usePropertyDropdownDirection } from "@src/components/PropertyField/PropertyDropdownDirection";
import {
  FieldRow,
  type FieldRowVariant,
} from "@src/components/PropertyField/PropertyFieldEditable";
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
  /** Render hidden fields behind a more-properties menu. */
  showMoreMenu?: boolean;
  /** Keep the legacy group inset around row-style fields. */
  withGroupInset?: boolean;
  /** Reserve the legacy label column beside each row value. */
  showLabels?: boolean;
}

export const PROJECT_PROPERTY_CONCISE_FIELDS: ProjectPropertyFieldKey[] = [
  "status",
  "priority",
  "lead",
  "targetDate",
  "linkedRepos",
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
  withGroupInset = true,
  showLabels = true,
}) => {
  const dropdownDirection = usePropertyDropdownDirection();
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
    handleDateChange,
    formatDate,
  } = usePropertiesPanel({ project, onUpdate, containerRef });

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

  const handleMoreClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMoreMenuPosition({
        x: rect.left,
        y: dropdownDirection === "up" ? rect.top - 6 : rect.bottom + 6,
      });
    },
    [dropdownDirection]
  );

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
            : `flex flex-col ${withGroupInset ? "px-2" : ""}`
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
          showLabels={showLabels}
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
          showLabels={showLabels}
        />

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
              label={showLabels ? t("properties.startDate") : undefined}
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
              label={showLabels ? t("properties.targetDate") : undefined}
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
                {showLabels ? (
                  <span className="w-[72px] shrink-0 text-xs text-text-2">
                    {t("properties.completion")}
                  </span>
                ) : null}
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
            icon={<ListChevronsUpDown size={DROPDOWN_ITEM.iconSize} />}
            onClick={handleMoreClick}
            title={t("common:actions.more")}
            htmlType="button"
            className={`!px-3 ${pillControlStateClass(Boolean(moreMenuPosition))}`}
          />
        )}
      </div>

      {moreMenuPosition && (
        <WorkItemContextMenu
          items={moreMenuItems}
          position={moreMenuPosition}
          onClose={() => setMoreMenuPosition(null)}
          openDirection={dropdownDirection}
        />
      )}
    </>
  );
};

export default ProjectPropertyFields;
