import Checkbox from "@src/components/Checkbox";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";

import { RowPropertyDropdown } from "./RowPropertyDropdown";
import type { LeadingCellsProps } from "./types";

export function LeadingCells({
  shortId,
  priority,
  status,
  isChecked,
  showCheckboxes,
  onCheckboxChange,
  onPriorityChange,
  onStatusChange,
  externalStatusValue,
  externalStatusOptions,
  onExternalStatusChange,
  statusDisabled = false,
  readonly = false,
}: LeadingCellsProps) {
  const priorityOption = WORK_ITEM_PRIORITY_OPTIONS.find(
    (option) => option.value === priority
  );
  const isGitHubIssueStatus = GITHUB_ISSUE_STATUS_OPTIONS.some(
    (option) => option.value === status
  );
  const statusOptions = isGitHubIssueStatus
    ? GITHUB_ISSUE_STATUS_OPTIONS
    : WORK_ITEM_STATUS_OPTIONS;
  const statusOption = statusOptions.find((option) => option.value === status);
  const currentExternalStatusOption = externalStatusOptions?.find(
    (option) => option.value === externalStatusValue
  );
  const priorityLabel = priorityOption?.label ?? priority;
  const statusLabel =
    currentExternalStatusOption?.label ?? statusOption?.label ?? status;
  const canUseExternalStatusDropdown =
    !!externalStatusValue &&
    !!currentExternalStatusOption &&
    !!externalStatusOptions?.length &&
    !!onExternalStatusChange;

  return (
    <div className="grid shrink-0 grid-cols-[1.75rem_auto_5.5rem_auto] items-center gap-1">
      <div
        className={`checkbox-cell flex h-7 w-7 items-center justify-center ${
          showCheckboxes ? "visible" : "invisible group-hover/wiRow:visible"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <Checkbox
          checked={isChecked}
          onChange={onCheckboxChange}
          size="small"
        />
      </div>

      <RowPropertyDropdown
        value={priority}
        label={priorityLabel}
        icon={priorityOption?.icon}
        iconColor={priorityOption?.color}
        options={WORK_ITEM_PRIORITY_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
          icon: option.icon,
          iconColor: option.color,
        }))}
        onChange={(value) => onPriorityChange?.(value)}
        readonly={readonly || !onPriorityChange}
        triggerVariant={priority === "none" ? "iconOnly" : "pill"}
        maxWidthClassName={
          priority === "none" ? "w-7 max-w-7" : "max-w-[140px]"
        }
        dataTestId={`work-item-priority-${shortId}`}
      />

      <div className="min-w-0 truncate text-xs font-medium tabular-nums text-text-3">
        {shortId}
      </div>

      <RowPropertyDropdown
        value={canUseExternalStatusDropdown ? externalStatusValue : status}
        label={statusLabel}
        icon={currentExternalStatusOption?.icon ?? statusOption?.icon}
        iconColor={currentExternalStatusOption?.color ?? statusOption?.color}
        options={(canUseExternalStatusDropdown
          ? externalStatusOptions
          : statusOptions
        ).map((option) => ({
          value: option.value,
          label: option.label,
          icon: option.icon,
          iconColor: option.color,
        }))}
        onChange={(value) => {
          if (canUseExternalStatusDropdown) {
            void onExternalStatusChange?.(value);
            return;
          }
          onStatusChange?.(value as typeof status);
        }}
        readonly={
          readonly ||
          statusDisabled ||
          (!canUseExternalStatusDropdown && !onStatusChange)
        }
        triggerVariant={
          (canUseExternalStatusDropdown ? externalStatusValue : status) ===
          "backlog"
            ? "iconOnly"
            : "pill"
        }
        maxWidthClassName={
          (canUseExternalStatusDropdown ? externalStatusValue : status) ===
          "backlog"
            ? "w-7 max-w-7"
            : "max-w-[150px]"
        }
        dataTestId={`work-item-status-${shortId}`}
      />
    </div>
  );
}
