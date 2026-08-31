import { useState } from "react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import PersonAvatar from "@src/components/PersonAvatar";
import { PropertyDropdownField } from "@src/components/PropertyField/PropertyDropdownField";
import {
  type FieldRowVariant,
  Option,
} from "@src/components/PropertyField/PropertyFieldEditable";
import {
  AtIcon,
  HierarchyCircle01Icon,
  HugeiconsIcon,
  UserIcon,
} from "@src/icons";
import type { Person } from "@src/types/core/shared";
import {
  GITHUB_ISSUE_STATUS,
  type WorkItem as WorkItemExtended,
} from "@src/types/core/workItem";

import type {
  WorkItemExternalAssigneeConfig,
  WorkItemExternalAssigneeOption,
} from "./types";

interface AssigneePropertyFieldProps {
  workItem: WorkItemExtended;
  availableMembers: Person[];
  onAssigneeChange: (person: Person | null) => void;
  t: (key: string) => string;
  fieldVariant?: FieldRowVariant;
  placement?: "inline" | "portal";
  triggerVariant?: "row" | "pill" | "iconOnly";
  active?: boolean;
  onActiveChange?: (active: boolean) => void;
  readonly?: boolean;
  maxWidthClassName?: string;
  borderless?: boolean;
  externalConfig?: WorkItemExternalAssigneeConfig;
}

export function toggleExternalAssigneeIds(
  currentIds: string[],
  assigneeId: string
): string[] {
  const normalizedId = assigneeId.toLowerCase();
  const selected = currentIds.some(
    (currentId) => currentId.toLowerCase() === normalizedId
  );
  return selected
    ? currentIds.filter((currentId) => currentId.toLowerCase() !== normalizedId)
    : [...currentIds, assigneeId];
}

function isGitHubIssueWorkItem(workItem: WorkItemExtended): boolean {
  return (
    workItem.workItemStatus === GITHUB_ISSUE_STATUS.OPEN ||
    workItem.workItemStatus === GITHUB_ISSUE_STATUS.CLOSED
  );
}

function buildGitHubAvatarFallback(person: Person): string | undefined {
  const login = person.id.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    return undefined;
  }
  return `https://github.com/${login}.png?size=64`;
}

function getAssigneeAvatarSrc(workItem: WorkItemExtended): string | undefined {
  if (!workItem.assignee) return undefined;
  return (
    workItem.assignee.avatar ??
    (isGitHubIssueWorkItem(workItem)
      ? buildGitHubAvatarFallback(workItem.assignee)
      : undefined)
  );
}

function renderAssigneeIcon(workItem: WorkItemExtended) {
  if (!workItem.assignee)
    return (
      <HugeiconsIcon
        icon={UserIcon}
        data-icon="user"
        size={DROPDOWN_ITEM.iconSize}
      />
    );
  if (workItem.assigneeType === "agent") {
    return (
      <HugeiconsIcon
        icon={AtIcon}
        data-icon="at-sign"
        size={DROPDOWN_ITEM.iconSize}
        className="text-primary-6"
      />
    );
  }
  if (workItem.assigneeType === "org") {
    return (
      <HugeiconsIcon
        icon={HierarchyCircle01Icon}
        data-icon="network"
        size={DROPDOWN_ITEM.iconSize}
        className="text-primary-6"
      />
    );
  }
  return (
    <PersonAvatar
      size={DROPDOWN_ITEM.iconSize}
      name={workItem.assignee.name}
      src={getAssigneeAvatarSrc(workItem)}
      color={workItem.assignee.color}
    />
  );
}

function renderExternalAssigneeIcon(
  option: WorkItemExternalAssigneeOption | undefined
) {
  if (!option)
    return (
      <HugeiconsIcon
        icon={UserIcon}
        data-icon="user"
        size={DROPDOWN_ITEM.iconSize}
      />
    );
  return (
    <PersonAvatar
      size={DROPDOWN_ITEM.iconSize}
      name={option.label}
      src={option.avatar}
    />
  );
}

export function AssigneePropertyField({
  workItem,
  availableMembers,
  onAssigneeChange,
  t,
  fieldVariant = "row",
  placement = "inline",
  triggerVariant,
  active,
  onActiveChange,
  readonly = false,
  maxWidthClassName,
  borderless = false,
  externalConfig,
}: AssigneePropertyFieldProps) {
  const [savingExternalAssignee, setSavingExternalAssignee] = useState(false);
  const [externalPickerOpen, setExternalPickerOpen] = useState(false);
  const externalDisabled =
    readonly || !!externalConfig?.disabled || savingExternalAssignee;
  const externalOptionsById = new Map<string, WorkItemExternalAssigneeOption>();
  for (const currentId of externalConfig?.currentAssigneeIds ?? []) {
    externalOptionsById.set(currentId.toLowerCase(), {
      id: currentId,
      label: currentId,
    });
  }
  for (const option of externalConfig?.options ?? []) {
    externalOptionsById.set(option.id.toLowerCase(), option);
  }
  const externalOptions = Array.from(externalOptionsById.values());
  const currentExternalOptions = (externalConfig?.currentAssigneeIds ?? []).map(
    (id) => externalOptionsById.get(id.toLowerCase()) ?? { id, label: id }
  );
  const externalLabel =
    currentExternalOptions.map((option) => option.label).join(", ") ||
    t("workItems.properties.noAssignee");
  const handleExternalChange = async (
    assigneeIds: string[],
    close?: () => void
  ) => {
    if (!externalConfig || externalDisabled) return;
    setSavingExternalAssignee(true);
    try {
      await externalConfig.onChangeAssigneeIds(assigneeIds);
      close?.();
    } finally {
      setSavingExternalAssignee(false);
    }
  };
  const handleExternalActiveChange = (nextActive: boolean) => {
    if (nextActive && !externalDisabled) void externalConfig?.onOpen?.();
    if (onActiveChange) onActiveChange(nextActive);
    else setExternalPickerOpen(nextActive);
  };

  if (externalConfig) {
    return (
      <div
        title={externalDisabled ? externalConfig.readonlyReason : externalLabel}
        className="contents"
      >
        <PropertyDropdownField
          value={externalConfig.currentAssigneeIds.join(",") || "__none__"}
          label={externalLabel}
          icon={renderExternalAssigneeIcon(currentExternalOptions[0])}
          options={[]}
          placement={placement}
          fieldVariant={fieldVariant}
          triggerVariant={triggerVariant ?? fieldVariant}
          selected={currentExternalOptions.length > 0}
          searchable
          searchPlaceholder={t("common:actions.search")}
          matchTriggerWidth
          active={active ?? externalPickerOpen}
          onActiveChange={handleExternalActiveChange}
          readonly={externalDisabled}
          maxWidthClassName={maxWidthClassName}
          borderless={borderless}
          dataTestId={`work-item-property-assignee-${workItem.session_id}`}
          renderOptions={(searchQuery, close) => {
            if (externalConfig.loading) {
              return (
                <div className="px-2.5 py-2 text-xs text-text-3">
                  {t("common:status.loading")}
                </div>
              );
            }
            if (externalConfig.error) {
              return (
                <div className="px-2.5 py-2 text-xs text-danger-6">
                  {externalConfig.error}
                </div>
              );
            }
            const query = searchQuery.trim().toLowerCase();
            const filteredOptions = externalOptions.filter(
              (option) => !query || option.label.toLowerCase().includes(query)
            );
            const selectedIds = new Set(
              externalConfig.currentAssigneeIds.map((id) => id.toLowerCase())
            );
            return (
              <>
                <Option
                  icon={
                    <HugeiconsIcon
                      icon={UserIcon}
                      data-icon="user"
                      size={DROPDOWN_ITEM.iconSize}
                    />
                  }
                  label={t("workItems.properties.noAssignee")}
                  isSelected={externalConfig.currentAssigneeIds.length === 0}
                  onClick={() => void handleExternalChange([], close)}
                  dataTestId={`work-item-property-assignee-${workItem.session_id}-option-none`}
                />
                {filteredOptions.map((option) => (
                  <Option
                    key={option.id}
                    label={option.label}
                    isSelected={selectedIds.has(option.id.toLowerCase())}
                    onClick={() =>
                      void handleExternalChange(
                        toggleExternalAssigneeIds(
                          externalConfig.currentAssigneeIds,
                          option.id
                        ),
                        close
                      )
                    }
                    dataTestId={`work-item-property-assignee-${workItem.session_id}-option-${option.id}`}
                  >
                    <PersonAvatar
                      size={DROPDOWN_ITEM.iconSize}
                      name={option.label}
                      src={option.avatar}
                    />
                    <span className="flex-1 truncate">{option.label}</span>
                  </Option>
                ))}
              </>
            );
          }}
        />
      </div>
    );
  }

  const label = workItem.assignee?.name || t("workItems.properties.noAssignee");
  return (
    <PropertyDropdownField
      value={workItem.assignee?.id ?? "__none__"}
      label={label}
      icon={renderAssigneeIcon(workItem)}
      options={[]}
      placement={placement}
      fieldVariant={fieldVariant}
      triggerVariant={triggerVariant ?? fieldVariant}
      selected={!!workItem.assignee}
      searchable
      searchPlaceholder={t("common:actions.search")}
      matchTriggerWidth
      active={active}
      onActiveChange={onActiveChange}
      onClear={() => onAssigneeChange(null)}
      readonly={readonly}
      maxWidthClassName={maxWidthClassName}
      borderless={borderless}
      renderOptions={(searchQuery, close) => {
        const query = searchQuery?.toLowerCase() ?? "";
        const filteredMembers = query
          ? availableMembers.filter((person) =>
              person.name.toLowerCase().includes(query)
            )
          : availableMembers;
        const select = (person: Person | null) => {
          onAssigneeChange(person);
          close();
        };

        return (
          <>
            <Option
              icon={
                <HugeiconsIcon
                  icon={UserIcon}
                  data-icon="user"
                  size={DROPDOWN_ITEM.iconSize}
                />
              }
              label={t("workItems.properties.noAssignee")}
              isSelected={!workItem.assignee}
              onClick={() => select(null)}
            />
            {filteredMembers.length > 0 && (
              <div className={DROPDOWN_CLASSES.sectionLabel}>
                {t("workItems.properties.membersGroup")}
              </div>
            )}
            {filteredMembers.map((person) => (
              <Option
                key={person.id}
                isSelected={workItem.assignee?.id === person.id}
                label={person.name}
                onClick={() => select(person)}
              >
                <PersonAvatar
                  size={DROPDOWN_ITEM.iconSize}
                  name={person.name}
                  src={person.avatar}
                  color={person.color}
                />
                <span className="flex-1 truncate">{person.name}</span>
              </Option>
            ))}
          </>
        );
      }}
    />
  );
}
