/**
 * Status, Health, and Priority field rows for ProjectPropertyFields.
 * Extracted to keep the parent component under the UI line limit.
 */
import React from "react";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  FieldRow,
  type FieldRowVariant,
  Option,
  SearchableDropdown,
} from "@src/components/PropertyField/PropertyFieldEditable";
import { CircleIcon, Flag01Icon, HugeiconsIcon } from "@src/icons";
import { getProjectPriorityConfig } from "@src/modules/ProjectManager/config/manage";

import { HEALTH_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS } from "../config";
import type {
  PickerType,
  ProjectData,
  ProjectHealth,
  ProjectPriority,
  ProjectPropertyFieldKey,
  ProjectStatus,
} from "../types";

export interface StatusHealthPriorityFieldsProps {
  project: ProjectData;
  openPicker: PickerType;
  togglePicker: (key: PickerType) => void;
  currentStatus: (typeof STATUS_OPTIONS)[number] | undefined;
  currentHealth: (typeof HEALTH_OPTIONS)[number] | undefined;
  currentPriority: (typeof PRIORITY_OPTIONS)[number] | undefined;
  handleStatusChange: (value: ProjectStatus) => void;
  handleHealthChange: (value: ProjectHealth) => void;
  handlePriorityChange: (value: ProjectPriority) => void;
  t: (key: string) => string;
  fieldVariant?: FieldRowVariant;
  visibleFields: Set<ProjectPropertyFieldKey>;
  showLabels?: boolean;
}

const StatusHealthPriorityFields: React.FC<StatusHealthPriorityFieldsProps> = ({
  project,
  openPicker,
  togglePicker,
  currentStatus,
  currentHealth,
  currentPriority,
  handleStatusChange,
  handleHealthChange,
  handlePriorityChange,
  t,
  fieldVariant = "row",
  visibleFields,
  showLabels = true,
}) => (
  <>
    {/* Status */}
    {(visibleFields.has("status") || openPicker === "status") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={CircleIcon}
              data-icon="circle"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          iconColor={currentStatus?.color}
          label={showLabels ? t("properties.status") : undefined}
          value={
            currentStatus ? t(currentStatus.labelKey) : t("properties.noStatus")
          }
          isSelected
          isActive={openPicker === "status"}
          variant={fieldVariant}
          onClick={() => togglePicker("status")}
        />
        {openPicker === "status" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? STATUS_OPTIONS.filter((option) =>
                    t(option.labelKey)
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase())
                  )
                : STATUS_OPTIONS;
              return filtered.map((option) => (
                <Option
                  key={option.value}
                  icon={
                    <HugeiconsIcon
                      icon={CircleIcon}
                      data-icon="circle"
                      size={DROPDOWN_ITEM.iconSize}
                    />
                  }
                  iconColor={option.color}
                  label={t(option.labelKey)}
                  isSelected={project.status === option.value}
                  onClick={() => handleStatusChange(option.value)}
                />
              ));
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Health */}
    {(visibleFields.has("health") || openPicker === "health") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={CircleIcon}
              data-icon="circle"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          iconColor={currentHealth?.color}
          label={showLabels ? t("properties.health") : undefined}
          value={
            currentHealth
              ? t(currentHealth.labelKey)
              : t("properties.noUpdates")
          }
          isSelected={project.health !== "no_updates"}
          isActive={openPicker === "health"}
          variant={fieldVariant}
          onClick={() => togglePicker("health")}
        />
        {openPicker === "health" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? HEALTH_OPTIONS.filter((option) =>
                    t(option.labelKey)
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase())
                  )
                : HEALTH_OPTIONS;
              return filtered.map((option) => (
                <Option
                  key={option.value}
                  icon={
                    <HugeiconsIcon
                      icon={CircleIcon}
                      data-icon="circle"
                      size={DROPDOWN_ITEM.iconSize}
                    />
                  }
                  iconColor={option.color}
                  label={t(option.labelKey)}
                  isSelected={project.health === option.value}
                  onClick={() => handleHealthChange(option.value)}
                />
              ));
            }}
          </SearchableDropdown>
        )}
      </div>
    )}

    {/* Priority */}
    {(visibleFields.has("priority") || openPicker === "priority") && (
      <div
        className={
          fieldVariant === "pill"
            ? "relative flex min-h-7 min-w-0 max-w-[220px] items-center"
            : "relative flex min-h-[36px] w-full items-center"
        }
      >
        <FieldRow
          icon={
            <HugeiconsIcon
              icon={Flag01Icon}
              data-icon="flag"
              size={DROPDOWN_ITEM.iconSize}
            />
          }
          iconColor={currentPriority?.color}
          label={showLabels ? t("properties.priority") : undefined}
          value={
            currentPriority
              ? t(currentPriority.labelKey)
              : t("properties.noPriority")
          }
          isSelected={project.priority !== "none"}
          isActive={openPicker === "priority"}
          variant={fieldVariant}
          onClick={() => togglePicker("priority")}
        />
        {openPicker === "priority" && (
          <SearchableDropdown
            placeholder={t("common:actions.search")}
            widthMode={fieldVariant === "pill" ? "menu" : "match-parent"}
            align={fieldVariant === "pill" ? "auto" : "left"}
          >
            {(searchQuery) => {
              const filtered = searchQuery
                ? PRIORITY_OPTIONS.filter((option) =>
                    t(option.labelKey)
                      .toLowerCase()
                      .includes(searchQuery.toLowerCase())
                  )
                : PRIORITY_OPTIONS;
              return filtered.map((option) => {
                const priorityConfig = getProjectPriorityConfig(option.value);
                return (
                  <Option
                    key={option.value}
                    icon={priorityConfig.icon}
                    iconColor={priorityConfig.color}
                    label={t(option.labelKey)}
                    isSelected={project.priority === option.value}
                    onClick={() => handlePriorityChange(option.value)}
                  />
                );
              });
            }}
          </SearchableDropdown>
        )}
      </div>
    )}
  </>
);

export default StatusHealthPriorityFields;
