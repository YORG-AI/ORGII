import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  PILL_CONTROL_FIELD_FOCUS_CLASS,
  type PillControlFocusTreatment,
} from "@src/components/CompoundPill/config";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { getDropdownPanelStyle, useDropdownEngine } from "@src/hooks/dropdown";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";

import { usePropertyDropdownDirection } from "./PropertyDropdownDirection";
import {
  FieldRow,
  type FieldRowIdleSurface,
  type FieldRowVariant,
  Option,
} from "./PropertyFieldEditable";

export interface PropertyDropdownOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
  iconColor?: string;
  disabled?: boolean;
}

export type PropertyDropdownPlacement = "inline" | "portal";
export type PropertyDropdownTriggerVariant =
  | "row"
  | "pill"
  | "workstation-trail"
  | "iconOnly"
  | "iconChevron";

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
  /** Prevents interaction without changing the trigger's visual treatment. */
  interactionDisabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Size the dropdown panel to the rendered trigger instead of its content. */
  matchTriggerWidth?: boolean;
  selected?: boolean;
  active?: boolean;
  onActiveChange?: (active: boolean) => void;
  maxWidthClassName?: string;
  valueClassName?: string;
  compactPill?: boolean;
  /** Idle trigger surface. Defaults to the standard raised background. */
  idleSurface?: FieldRowIdleSurface;
  /** Border treatment while hovered/open. Defaults to the standard pill accent. */
  focusTreatment?: PillControlFocusTreatment;
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
  interactionDisabled = false,
  searchable = true,
  searchPlaceholder,
  matchTriggerWidth = false,
  selected = true,
  active,
  onActiveChange,
  maxWidthClassName,
  valueClassName,
  compactPill = false,
  idleSurface = "background",
  focusTreatment = "accent",
  onClear,
  borderless = false,
  renderOptions,
  dataTestId,
}: PropertyDropdownFieldProps<T>) {
  const dropdownDirection = usePropertyDropdownDirection();
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
    placement: dropdownDirection === "up" ? "top" : "bottom",
  });

  const close = useCallback(() => setOpen(false), [setOpen]);

  useEffect(() => {
    if (interactionDisabled && isOpen) close();
  }, [close, interactionDisabled, isOpen]);

  const filtered =
    searchable && searchQuery
      ? options.filter((option) =>
          option.label.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : options;

  const toggleOpen = useCallback(() => {
    if (!interactionDisabled) setOpen(!isOpen);
  }, [interactionDisabled, isOpen, setOpen]);

  const handleSelect = useCallback(
    (nextValue: T) => {
      if (interactionDisabled) return;
      void onChange?.(nextValue);
      close();
    },
    [close, interactionDisabled, onChange]
  );

  const resolvedTriggerVariant = triggerVariant ?? fieldVariant;
  const isRowTrigger =
    resolvedTriggerVariant === "row" ||
    resolvedTriggerVariant === "workstation-trail";
  const isIconTrigger =
    resolvedTriggerVariant === "iconOnly" ||
    resolvedTriggerVariant === "iconChevron";
  const isIconChevronTrigger = resolvedTriggerVariant === "iconChevron";
  const iconOnlyIdleBorderClass = borderless
    ? "border-transparent"
    : "border-border-2";
  const iconTriggerIdleSurfaceClass =
    idleSurface === "fill"
      ? "bg-fill-1 enabled:hover:bg-fill-2"
      : isIconChevronTrigger
        ? "bg-bg-2 hover:bg-fill-2"
        : "bg-transparent hover:bg-fill-2";
  const iconTriggerOpenClass =
    focusTreatment === "field"
      ? `bg-fill-2 text-text-3 ${PILL_CONTROL_FIELD_FOCUS_CLASS}`
      : "border-primary-6 bg-fill-2 text-primary-6";
  const containerClass = [
    "relative flex min-w-0 items-center",
    maxWidthClassName ??
      (isIconTrigger
        ? isIconChevronTrigger
          ? "w-12 max-w-12 shrink-0"
          : "w-7 max-w-7 shrink-0"
        : fieldVariant === "pill"
          ? "max-w-[220px] shrink-0"
          : "w-full"),
    readonly ? "opacity-80" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const trigger = isIconTrigger ? (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-disabled={readonly || interactionDisabled}
      className={`flex items-center justify-center rounded-full border border-solid transition-[border-color,box-shadow,background-color,color] ${isIconChevronTrigger ? "h-7 w-12 gap-0 px-px" : "h-6 w-6"} ${
        isOpen
          ? iconTriggerOpenClass
          : `${iconOnlyIdleBorderClass} ${iconTriggerIdleSurfaceClass} text-text-3 hover:border-border-3`
      } ${readonly ? "cursor-default" : "cursor-pointer"}`}
      style={iconColor ? { color: iconColor } : undefined}
      disabled={readonly}
      onClick={() => {
        if (!readonly && !interactionDisabled) toggleOpen();
      }}
    >
      <span
        className={`flex items-center justify-center ${isIconChevronTrigger ? "h-6 w-6" : "h-4 w-4"}`}
      >
        {icon}
      </span>
      {isIconChevronTrigger && !readonly ? (
        <span className="flex h-6 w-5 items-center justify-center">
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={12}
            strokeWidth={1.8}
          />
        </span>
      ) : null}
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
      suffix={
        fieldVariant === "pill" && !readonly ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            className="ml-1 shrink-0"
            size={12}
            strokeWidth={1.8}
          />
        ) : undefined
      }
      variant={fieldVariant}
      compactPill={compactPill}
      idleSurface={idleSurface}
      focusTreatment={focusTreatment}
      borderless={borderless}
      disabled={readonly}
      onClear={readonly || interactionDisabled ? undefined : onClear}
      onClick={() => {
        if (!readonly && !interactionDisabled) toggleOpen();
      }}
    />
  );

  const dropdownContent = () => {
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
            disabled={option.disabled}
            onClick={() => handleSelect(option.value)}
            dataTestId={
              dataTestId ? `${dataTestId}-option-${option.value}` : undefined
            }
          />
        ))}
      </>
    );
    return (
      <>
        {searchable && (
          <DropdownSearch
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={searchPlaceholder}
            autoFocus
          />
        )}
        <div className={DROPDOWN_CLASSES.optionsContainer}>
          {optionsContent}
        </div>
      </>
    );
  };

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
          isIconTrigger
            ? `flex h-7 items-center justify-center ${isIconChevronTrigger ? "w-12" : "w-7"}`
            : isRowTrigger
              ? "w-full min-w-0"
              : undefined
        }
      >
        {trigger}
      </div>

      {!readonly &&
        !interactionDisabled &&
        isOpen &&
        placement === "inline" && (
          <div
            ref={dropdownRef}
            data-property-dropdown
            className={`absolute ${matchTriggerWidth ? "right-0 left-0" : fieldVariant === "pill" ? "left-0" : "right-2 left-2"} ${
              dropdownDirection === "up" ? "bottom-full mb-1" : "top-full mt-1"
            } flex flex-col ${!matchTriggerWidth && fieldVariant === "pill" ? DROPDOWN_WIDTHS.wideMenuClass : ""} ${DROPDOWN_CLASSES.panelAnimated}`}
          >
            {dropdownContent()}
          </div>
        )}

      {!readonly &&
        !interactionDisabled &&
        isOpen &&
        placement === "portal" &&
        isPositioned &&
        createPortal(
          <div
            ref={dropdownRef}
            data-property-dropdown
            className={`fixed flex flex-col ${matchTriggerWidth ? "" : DROPDOWN_WIDTHS.wideMenuClass} ${DROPDOWN_CLASSES.panelAnimated}`}
            style={getDropdownPanelStyle(dropdownPosition, {
              widthMode: matchTriggerWidth ? "match" : "none",
              constrainHeight: false,
            })}
          >
            {dropdownContent()}
          </div>,
          document.body
        )}
    </div>
  );
}
