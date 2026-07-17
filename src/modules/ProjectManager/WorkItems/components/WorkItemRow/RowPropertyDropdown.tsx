import React from "react";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import {
  PropertyDropdownField,
  type PropertyDropdownOption,
  type PropertyDropdownTriggerVariant,
} from "@src/components/PropertyField/PropertyDropdownField";

export interface RowPropertyDropdownOption<
  T extends string,
> extends PropertyDropdownOption<T> {}

interface RowPropertyDropdownProps<T extends string> {
  value: T;
  label: string;
  icon: React.ReactNode;
  iconColor?: string;
  options: RowPropertyDropdownOption<T>[];
  onChange: (value: T) => void | Promise<void>;
  readonly?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  selected?: boolean;
  maxWidthClassName?: string;
  renderOptionIcon?: (option: RowPropertyDropdownOption<T>) => React.ReactNode;
  triggerVariant?: PropertyDropdownTriggerVariant;
  dataTestId?: string;
}

export function RowPropertyDropdown<T extends string>({
  value,
  label,
  icon,
  iconColor,
  options,
  onChange,
  readonly = false,
  searchable = false,
  searchPlaceholder,
  selected = true,
  maxWidthClassName = "max-w-[180px]",
  renderOptionIcon,
  triggerVariant = "pill",
  dataTestId,
}: RowPropertyDropdownProps<T>) {
  return (
    <PropertyDropdownField
      value={value}
      label={label}
      icon={icon}
      iconColor={iconColor}
      options={options}
      onChange={onChange}
      readonly={readonly}
      searchable={searchable}
      searchPlaceholder={searchPlaceholder}
      selected={selected}
      maxWidthClassName={maxWidthClassName}
      triggerVariant={triggerVariant}
      fieldVariant="pill"
      placement="portal"
      borderless
      dataTestId={dataTestId}
      renderOptions={
        renderOptionIcon
          ? (searchQuery, close) => {
              const filtered =
                searchable && searchQuery
                  ? options.filter((option) =>
                      option.label
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase())
                    )
                  : options;
              return filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`w-full justify-between text-left ${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} ${
                    option.value === value ? DROPDOWN_CLASSES.itemSelected : ""
                  }`}
                  onClick={() => {
                    void onChange(option.value);
                    close();
                  }}
                >
                  <span
                    className={`shrink-0 ${DROPDOWN_ITEM.iconSizeClass} [&_svg]:h-[13px] [&_svg]:w-[13px]`}
                  >
                    {renderOptionIcon(option)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {option.label}
                  </span>
                </button>
              ));
            }
          : undefined
      }
    />
  );
}
