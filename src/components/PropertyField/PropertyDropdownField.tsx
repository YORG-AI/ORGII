import React, { useCallback, useState } from "react";
import { createPortal } from "react-dom";

import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";

import {
  FieldRow,
  type FieldRowVariant,
  Option,
} from "./PropertyFieldEditable";

export interface PropertyDropdownOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  iconColor?: string;
}

export type PropertyDropdownPlacement = "inline" | "portal";
export type PropertyDropdownTriggerVariant = "row" | "pill" | "iconOnly";

interface PropertyDropdownFieldProps<T extends string> {
  value: T;
  label: string;
  icon: React.ReactNode;
  iconColor?: string;
  options?: PropertyDropdownOption<T>[];
  onChange?: (value: T) => void | Promise<void>;
  placement?: PropertyDropdownPlacement;
  triggerVariant?: PropertyDropdownTriggerVariant;
  fieldVariant?: FieldRowVariant;
  readonly?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  selected?: boolean;
  active?: boolean;
  onActiveChange?: (active: boolean) => void;
  maxWidthClassName?: string;
  valueClassName?: string;
  onClear?: () => void | Promise<void>;
  borderless?: boolean;
  renderOptions?: (searchQuery: string, close: () => void) => React.ReactNode;
  /** Stable selector; options derive `${dataTestId}-option-${value}`. */
  dataTestId?: string;
}

export function PropertyDropdownField<T extends string>({
  value,
  label,
  icon,
  iconColor,
  options = [],
  onChange,
  placement = "inline",
  triggerVariant,
  fieldVariant = "row",
  readonly = false,
  searchable = true,
  searchPlaceholder,
  selected = true,
  active,
  onActiveChange,
  maxWidthClassName,
  valueClassName,
  onClear,
  borderless = false,
  renderOptions,
  dataTestId,
}: PropertyDropdownFieldProps<T>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const controlledOpen = active ?? internalOpen;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (onActiveChange) onActiveChange(nextOpen);
      else setInternalOpen(nextOpen);
      if (!nextOpen) setSearchQuery("");
    },
    [onActiveChange]
  );
  const {
    isOpen,
    isPositioned,
    triggerRef,
    panelRef: dropdownRef,
    panelPosition: dropdownPosition,
    setIsOpen: setOpen,
  } = useDropdownEngine<HTMLDivElement>({
    open: controlledOpen,
    onOpenChange: handleOpenChange,
    gap: 4,
    align: "right",
    placement: "bottom",
  });

  const close = useCallback(() => setOpen(false), [setOpen]);

  const filtered =
    searchable && searchQuery
      ? options.filter((option) =>
          option.label.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : options;

  const toggleOpen = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);

  const handleSelect = useCallback(
    (nextValue: T) => {
      void onChange?.(nextValue);
      close();
    },
    [close, onChange]
  );

  const resolvedTriggerVariant = triggerVariant ?? fieldVariant;
  const isRowTrigger = resolvedTriggerVariant === "row";
  const iconOnlyIdleBorderClass = borderless
    ? "border-transparent"
    : "border-border-2";
  const containerClass = [
    "relative flex min-w-0 items-center",
    maxWidthClassName ??
      (resolvedTriggerVariant === "iconOnly"
        ? "w-7 max-w-7 shrink-0"
        : fieldVariant === "pill"
          ? "max-w-[220px] shrink-0"
          : "w-full"),
    readonly ? "opacity-80" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const trigger =
    resolvedTriggerVariant === "iconOnly" ? (
      <button
        type="button"
        title={label}
        aria-label={label}
        className={`flex h-6 w-6 items-center justify-center rounded-full border border-solid bg-transparent transition-[border-color,background-color,color] ${
          isOpen
            ? "border-primary-6 bg-fill-2 text-primary-6"
            : `${iconOnlyIdleBorderClass} text-text-3 hover:border-border-3 hover:bg-fill-2`
        } ${readonly ? "cursor-default" : "cursor-pointer"}`}
        style={iconColor ? { color: iconColor } : undefined}
        onClick={() => {
          if (!readonly) toggleOpen();
        }}
      >
        <span className="flex h-4 w-4 items-center justify-center">{icon}</span>
      </button>
    ) : (
      <FieldRow
        icon={icon}
        iconColor={iconColor}
        value={label}
        valueClassName={valueClassName}
        isSelected={selected}
        isActive={isOpen}
        showChevron
        variant={fieldVariant}
        borderless={borderless}
        onClear={readonly ? undefined : onClear}
        onClick={() => {
          if (!readonly) toggleOpen();
        }}
      />
    );

  const optionsContent = renderOptions ? (
    renderOptions(searchQuery, close)
  ) : (
    <>
      {filtered.map((option) => (
        <Option
          key={option.value}
          icon={option.icon}
          iconColor={option.iconColor}
          label={option.label}
          isSelected={option.value === value}
          onClick={() => handleSelect(option.value)}
          dataTestId={
            dataTestId ? `${dataTestId}-option-${option.value}` : undefined
          }
        />
      ))}
    </>
  );

  const dropdownContent = (
    <>
      {searchable && (
        <DropdownSearch
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={searchPlaceholder}
          autoFocus
        />
      )}
      <div className={DROPDOWN_CLASSES.optionsContainer}>{optionsContent}</div>
    </>
  );

  return (
    <div
      className={containerClass}
      onClick={(event) => event.stopPropagation()}
      data-testid={dataTestId}
      data-value={value}
    >
      <div
        ref={triggerRef}
        className={
          resolvedTriggerVariant === "iconOnly"
            ? "flex h-7 w-7 items-center justify-center"
            : isRowTrigger
              ? "w-full min-w-0"
              : undefined
        }
      >
        {trigger}
      </div>

      {!readonly && isOpen && placement === "inline" && (
        <div
          ref={dropdownRef}
          data-property-dropdown
          className={`absolute ${fieldVariant === "pill" ? "left-0" : "left-2 right-2"} top-full mt-1 flex flex-col ${fieldVariant === "pill" ? DROPDOWN_WIDTHS.wideMenuClass : ""} ${DROPDOWN_CLASSES.panelAnimated}`}
        >
          {dropdownContent}
        </div>
      )}

      {!readonly &&
        isOpen &&
        placement === "portal" &&
        isPositioned &&
        createPortal(
          <div
            ref={dropdownRef}
            data-property-dropdown
            className={`fixed flex flex-col ${DROPDOWN_WIDTHS.wideMenuClass} ${DROPDOWN_CLASSES.panelAnimated}`}
            style={{
              top: dropdownPosition.top,
              left:
                dropdownPosition.right === undefined
                  ? dropdownPosition.left
                  : undefined,
              right: dropdownPosition.right,
            }}
          >
            {dropdownContent}
          </div>,
          document.body
        )}
    </div>
  );
}
