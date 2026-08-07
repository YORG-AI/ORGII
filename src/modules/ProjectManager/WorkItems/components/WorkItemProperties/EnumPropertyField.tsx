import React from "react";

import {
  PropertyDropdownField,
  type PropertyDropdownOption,
} from "@src/components/PropertyField/PropertyDropdownField";
import type { FieldRowVariant } from "@src/components/PropertyField/PropertyFieldEditable";

interface EnumOption<T extends string> {
  value: T;
  icon?: React.ReactNode;
  color?: string;
}

interface EnumPropertyFieldProps<T extends string> {
  options: EnumOption<T>[];
  currentOption: EnumOption<T> | undefined;
  currentValue: T | undefined;
  displayValue: string;
  isSelected: boolean;
  isActive: boolean;
  searchPlaceholder: string;
  getLabel: (value: T) => string;
  onPickerActiveChange: (active: boolean) => void;
  onChange: (value: T) => void | Promise<void>;
  onClear?: () => void | Promise<void>;
  disabled?: boolean;
  fieldVariant?: FieldRowVariant;
  dataTestId?: string;
}

export function EnumPropertyField<T extends string>({
  options,
  currentOption,
  currentValue,
  displayValue,
  isSelected,
  isActive,
  searchPlaceholder,
  getLabel,
  onPickerActiveChange,
  onChange,
  onClear,
  disabled = false,
  fieldVariant = "row",
  dataTestId,
}: EnumPropertyFieldProps<T>) {
  const dropdownOptions: PropertyDropdownOption<T>[] = options.map(
    (option) => ({
      value: option.value,
      label: getLabel(option.value),
      icon: option.icon,
      iconColor: option.color,
    })
  );

  return (
    <PropertyDropdownField
      value={currentValue ?? dropdownOptions[0]?.value}
      label={displayValue}
      icon={currentOption?.icon}
      iconColor={currentOption?.color}
      options={dropdownOptions}
      onChange={onChange}
      placement={fieldVariant === "pill" ? "portal" : "inline"}
      fieldVariant={fieldVariant}
      triggerVariant={fieldVariant}
      readonly={disabled}
      searchable
      searchPlaceholder={searchPlaceholder}
      selected={isSelected}
      active={isActive && !disabled}
      onActiveChange={onPickerActiveChange}
      onClear={disabled ? undefined : onClear}
      maxWidthClassName={fieldVariant === "pill" ? "max-w-[220px]" : "w-full"}
      dataTestId={dataTestId}
    />
  );
}
