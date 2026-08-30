import { useState } from "react";

import type { FieldRowVariant } from "@src/components/PropertyField/PropertyFieldEditable";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  CircleIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { EnumPropertyField } from "./EnumPropertyField";
import type {
  WorkItemExternalStatusConfig,
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
  WorkItemPropertyPicker,
  WorkItemPropertyTranslator,
} from "./types";

interface StatusPrioritySectionProps {
  workItem: WorkItemExtended;
  openPicker: WorkItemPropertyPicker;
  togglePicker: (picker: WorkItemPropertyPicker) => void;
  handlers: WorkItemPropertyHandlers;
  externalStatusConfig?: WorkItemExternalStatusConfig;
  t: WorkItemPropertyTranslator;
  fieldVariant?: FieldRowVariant;
  visibleFields?: Set<WorkItemPropertyFieldKey>;
}

export function StatusPrioritySection({
  workItem,
  openPicker,
  togglePicker,
  handlers,
  externalStatusConfig,
  t,
  fieldVariant = "row",
  visibleFields,
}: StatusPrioritySectionProps) {
  const showStatus = !visibleFields || visibleFields.has("status");
  const showPriority = !visibleFields || visibleFields.has("priority");
  const [savingExternalStatus, setSavingExternalStatus] = useState(false);
  const externalStatusDisabled =
    !!externalStatusConfig?.disabled ||
    !!externalStatusConfig?.loading ||
    savingExternalStatus;

  const isGitHubIssueStatus = GITHUB_ISSUE_STATUS_OPTIONS.some(
    (option) => option.value === workItem.workItemStatus
  );
  const statusOptions = isGitHubIssueStatus
    ? GITHUB_ISSUE_STATUS_OPTIONS
    : WORK_ITEM_STATUS_OPTIONS;
  const currentStatus = statusOptions.find(
    (option) => option.value === (workItem.workItemStatus || "planned")
  );
  const currentPriority = WORK_ITEM_PRIORITY_OPTIONS.find(
    (option) => option.value === (workItem.priority || "none")
  );
  const externalStatusOptions =
    externalStatusConfig?.options.map((option) => ({
      value: option.id,
      color: option.color,
      disabled: option.id === externalStatusConfig.currentStatusId,
      icon:
        option.id === "open" ? (
          <HugeiconsIcon
            icon={CircleDotIcon}
            data-icon="circle-dot"
            size={13}
            strokeWidth={1.8}
            aria-hidden
          />
        ) : option.id === "closed" ? (
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            data-icon="check-circle-2"
            size={13}
            strokeWidth={1.8}
            aria-hidden
          />
        ) : (
          <HugeiconsIcon
            icon={CircleIcon}
            data-icon="circle"
            size={13}
            strokeWidth={1.8}
            aria-hidden
          />
        ),
    })) ?? [];
  const currentExternalStatusOption = externalStatusConfig
    ? externalStatusOptions.find(
        (option) => option.value === externalStatusConfig.currentStatusId
      )
    : undefined;
  const currentExternalStatusLabel = externalStatusConfig
    ? (externalStatusConfig.options.find(
        (option) => option.id === externalStatusConfig.currentStatusId
      )?.label ?? t("properties.noStatus"))
    : undefined;

  const handleExternalStatusChange = async (value: string) => {
    if (!externalStatusConfig || externalStatusDisabled) return;
    setSavingExternalStatus(true);
    try {
      await externalStatusConfig.onChangeStatusId(value);
      togglePicker(null);
    } finally {
      setSavingExternalStatus(false);
    }
  };

  if (!showStatus && !showPriority) return null;

  return (
    <>
      {showStatus &&
        (externalStatusConfig ? (
          <EnumPropertyField
            options={externalStatusOptions}
            currentOption={currentExternalStatusOption}
            currentValue={externalStatusConfig.currentStatusId}
            displayValue={
              currentExternalStatusLabel ?? t("properties.noStatus")
            }
            isSelected={!!externalStatusConfig.currentStatusId}
            isActive={openPicker === "status"}
            searchPlaceholder={t("common:actions.search")}
            getLabel={(value) =>
              externalStatusConfig.options.find((option) => option.id === value)
                ?.label ?? value
            }
            fieldVariant={fieldVariant}
            onPickerActiveChange={(active) =>
              togglePicker(active ? "status" : null)
            }
            onChange={handleExternalStatusChange}
            disabled={externalStatusDisabled}
            dataTestId={`work-item-property-status-${workItem.session_id}`}
          />
        ) : (
          <EnumPropertyField
            options={statusOptions}
            currentOption={currentStatus}
            currentValue={workItem.workItemStatus}
            displayValue={
              currentStatus
                ? t(`workItems.statusLabels.${currentStatus.value}`)
                : t("workItems.statusFilters.todo")
            }
            isSelected
            isActive={openPicker === "status"}
            searchPlaceholder={t("common:actions.search")}
            getLabel={(value) => t(`workItems.statusLabels.${value}`)}
            fieldVariant={fieldVariant}
            onPickerActiveChange={(active) =>
              togglePicker(active ? "status" : null)
            }
            onChange={handlers.handleStatusChange}
            dataTestId={`work-item-property-status-${workItem.session_id}`}
          />
        ))}

      {showPriority && (
        <EnumPropertyField
          options={WORK_ITEM_PRIORITY_OPTIONS}
          currentOption={currentPriority}
          currentValue={workItem.priority}
          displayValue={
            currentPriority
              ? t(`workItems.priorityLabels.${currentPriority.value}`)
              : t("properties.noPriority")
          }
          isSelected={!!workItem.priority && workItem.priority !== "none"}
          isActive={openPicker === "priority"}
          searchPlaceholder={t("common:actions.search")}
          getLabel={(value) => t(`workItems.priorityLabels.${value}`)}
          fieldVariant={fieldVariant}
          onPickerActiveChange={(active) =>
            togglePicker(active ? "priority" : null)
          }
          onChange={handlers.handlePriorityChange}
          onClear={() => handlers.handlePriorityChange("none")}
          dataTestId={`work-item-property-priority-${workItem.session_id}`}
        />
      )}
    </>
  );
}
