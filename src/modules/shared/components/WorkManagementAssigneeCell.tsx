import { UserRound } from "lucide-react";
import { useState } from "react";

import Avatar from "@src/components/Avatar";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { PropertyDropdownField } from "@src/components/PropertyField/PropertyDropdownField";
import { Option } from "@src/components/PropertyField/PropertyFieldEditable";

export interface WorkManagementAssigneeOption {
  id: string;
  label: string;
  avatar?: string;
}

interface WorkManagementAssigneeCellProps {
  currentAssigneeIds: string[];
  options: WorkManagementAssigneeOption[];
  noneLabel: string;
  loadingLabel: string;
  searchPlaceholder: string;
  readonlyReason?: string;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  interactionDisabled?: boolean;
  multiple?: boolean;
  dataTestId: string;
  onOpen?: () => void | Promise<void>;
  onChangeAssigneeIds?: (assigneeIds: string[]) => void | Promise<void>;
}

export function toggleWorkManagementAssigneeIds(
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

export function WorkManagementAssigneeCell({
  currentAssigneeIds,
  options,
  noneLabel,
  loadingLabel,
  searchPlaceholder,
  readonlyReason,
  loading = false,
  error = null,
  disabled = false,
  interactionDisabled = false,
  multiple = false,
  dataTestId,
  onOpen,
  onChangeAssigneeIds,
}: WorkManagementAssigneeCellProps) {
  const [open, setOpen] = useState(false);
  const readonly = disabled || !onChangeAssigneeIds;
  const optionsById = new Map<string, WorkManagementAssigneeOption>();
  for (const currentId of currentAssigneeIds) {
    optionsById.set(currentId.toLowerCase(), {
      id: currentId,
      label: currentId,
    });
  }
  for (const option of options) {
    optionsById.set(option.id.toLowerCase(), option);
  }
  const resolvedOptions = Array.from(optionsById.values());
  const currentOptions = currentAssigneeIds.map(
    (id) => optionsById.get(id.toLowerCase()) ?? { id, label: id }
  );
  const label =
    currentOptions.map((option) => option.label).join(", ") || noneLabel;
  const firstAssignee = currentOptions[0];
  const triggerIcon = firstAssignee ? (
    <Avatar size={24} src={firstAssignee.avatar}>
      {firstAssignee.label.charAt(0).toUpperCase()}
    </Avatar>
  ) : (
    <UserRound size={14} strokeWidth={1.8} />
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && interactionDisabled) return;
    setOpen(nextOpen);
    if (nextOpen && !readonly) void onOpen?.();
  };
  const handleChange = (assigneeIds: string[], close: () => void) => {
    if (readonly || interactionDisabled || !onChangeAssigneeIds) return;
    void onChangeAssigneeIds(assigneeIds);
    close();
  };

  return (
    <div title={readonly ? readonlyReason || label : label}>
      <PropertyDropdownField
        value={currentAssigneeIds.join(",") || "__none__"}
        label={label}
        icon={triggerIcon}
        selected={currentAssigneeIds.length > 0}
        active={open}
        onActiveChange={handleOpenChange}
        readonly={readonly}
        interactionDisabled={interactionDisabled}
        searchable
        searchPlaceholder={searchPlaceholder}
        triggerVariant={readonly ? "iconOnly" : "iconChevron"}
        fieldVariant="pill"
        idleSurface="fill"
        focusTreatment="field"
        placement="portal"
        borderless
        dataTestId={dataTestId}
        renderOptions={(searchQuery, close) => {
          if (loading) {
            return (
              <div className="px-2.5 py-2 text-xs text-text-3">
                {loadingLabel}
              </div>
            );
          }
          if (error) {
            return (
              <div className="px-2.5 py-2 text-xs text-danger-6">{error}</div>
            );
          }
          const query = searchQuery.trim().toLowerCase();
          const filteredOptions = resolvedOptions.filter(
            (option) => !query || option.label.toLowerCase().includes(query)
          );
          const selectedIds = new Set(
            currentAssigneeIds.map((id) => id.toLowerCase())
          );
          return (
            <>
              <Option
                icon={<UserRound size={14} strokeWidth={1.8} />}
                label={noneLabel}
                isSelected={currentAssigneeIds.length === 0}
                onClick={() => handleChange([], close)}
                dataTestId={`${dataTestId}-option-none`}
              />
              {filteredOptions.map((option) => (
                <Option
                  key={option.id}
                  label={option.label}
                  isSelected={selectedIds.has(option.id.toLowerCase())}
                  onClick={() =>
                    handleChange(
                      multiple
                        ? toggleWorkManagementAssigneeIds(
                            currentAssigneeIds,
                            option.id
                          )
                        : [option.id],
                      close
                    )
                  }
                  dataTestId={`${dataTestId}-option-${option.id}`}
                >
                  <Avatar size={DROPDOWN_ITEM.iconSize} src={option.avatar}>
                    {option.label.charAt(0).toUpperCase()}
                  </Avatar>
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
