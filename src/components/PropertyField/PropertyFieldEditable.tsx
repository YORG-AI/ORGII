/**
 * PropertyFieldEditable Component
 *
 * Reusable editable property field components used in properties panels
 * Extracted from WorkItem/Project PropertiesPanel pattern
 * Uses DROPDOWN_CLASSES and DropdownSearch for consistency with settings.
 */
import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import {
  type PillControlFocusTreatment,
  pillControlStateClass,
} from "@src/components/CompoundPill/config";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import { getPositionedOverlayVisibilityStyle } from "@src/components/Dropdown/positioning";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import { ArrowDown01Icon, HugeiconsIcon, Pen01Icon } from "@src/icons";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { usePropertyDropdownDirection } from "./PropertyDropdownDirection";

// ============================================
// FieldRow - Interactive row that opens dropdowns
// ============================================

export type FieldRowVariant = "row" | "pill" | "workstation-trail";
export type FieldRowIdleSurface = "background" | "fill";

export interface FieldRowProps {
  icon: React.ReactNode;
  iconColor?: string;
  label?: string;
  value: string;
  valueClassName?: string;
  isSelected?: boolean;
  isActive?: boolean;
  showChevron?: boolean;
  /** Use pen icon instead of chevron (for text edit, calendar pickers) */
  usePencil?: boolean;
  suffix?: React.ReactNode;
  variant?: FieldRowVariant;
  compactPill?: boolean;
  idleSurface?: FieldRowIdleSurface;
  /** Border treatment while hovered/open. Defaults to the standard pill accent. */
  focusTreatment?: PillControlFocusTreatment;
  borderless?: boolean;
  disabled?: boolean;
  clearLabel?: string;
  onClear?: () => void;
  onClick: () => void;
}

export const FieldRow: React.FC<FieldRowProps> = ({
  icon,
  iconColor,
  label,
  value,
  valueClassName = "",
  isSelected,
  isActive = false,
  showChevron = true,
  usePencil = false,
  suffix,
  variant = "row",
  compactPill = false,
  idleSurface = "background",
  focusTreatment = "accent",
  borderless = false,
  disabled = false,
  onClick,
}) => {
  const EditIcon = usePencil ? Pen01Icon : ArrowDown01Icon;
  const pillBorderClass = borderless ? "border-transparent" : "border-border-2";
  const iconContent = icon ? (
    <span
      className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3"
      style={iconColor ? { color: iconColor } : undefined}
    >
      {icon}
    </span>
  ) : undefined;

  if (variant === "pill") {
    return (
      <div className="flex min-h-7 shrink-0 items-center overflow-visible">
        <Button
          htmlType="button"
          variant="secondary"
          size="small"
          shape="round"
          icon={iconContent}
          onClick={onClick}
          disabled={disabled}
          className={`max-w-[220px] ${compactPill ? "px-2!" : ""} ${pillBorderClass} ${pillControlStateClass(isActive, idleSurface, focusTreatment)}`}
          data-field-row
        >
          <span className="inline-flex max-w-full min-w-0 items-center gap-1">
            <span
              className={`min-w-0 truncate leading-[18px] ${valueClassName}`}
            >
              {value}
            </span>
            {suffix}
          </span>
        </Button>
      </div>
    );
  }

  const isWorkstationTrail = variant === "workstation-trail";

  return (
    <div
      className={
        isWorkstationTrail
          ? `${WORKSTATION_TRAIL_CONTENT.row} w-full`
          : "flex min-h-8 w-full min-w-0 items-center gap-1 px-2 py-0.5"
      }
    >
      {label && (
        <span className="w-[72px] shrink-0 text-xs text-text-2">{label}</span>
      )}
      <div
        data-field-row
        className={`group/field flex min-w-0 flex-1 items-center ${isWorkstationTrail ? "h-full rounded-lg" : "rounded-md"} transition-colors hover:bg-surface-hover ${isActive ? "bg-surface-hover" : "bg-transparent"}`}
      >
        <button
          type="button"
          className={
            isWorkstationTrail
              ? `${WORKSTATION_TRAIL_CONTENT.rowContent} cursor-pointer border-none bg-transparent outline-none`
              : "flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent px-1.5 py-1.5 text-left outline-none"
          }
          onClick={onClick}
          disabled={disabled}
        >
          {iconContent}
          <span
            className={`flex-1 truncate text-xs text-text-1 ${isSelected ? "font-semibold" : ""} ${valueClassName}`}
          >
            {value}
          </span>
          {suffix}
        </button>
        {showChevron && (
          <button
            type="button"
            aria-label="Open"
            onClick={onClick}
            disabled={disabled}
            className={`mr-1 flex h-6 w-5 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-text-3 ${isActive ? "flex" : "hidden group-hover/field:flex"}`}
          >
            <HugeiconsIcon icon={EditIcon} size={DROPDOWN_ITEM.iconSize} />
          </button>
        )}
      </div>
    </div>
  );
};

// ============================================
// Dropdown - Container for options (relative positioning)
// ============================================

export type DropdownWidthMode = "match-parent" | "menu";
export type DropdownAlign = "left" | "right" | "auto";

/**
 * Property pills use their trailing edge as the menu anchor. This keeps wide
 * pickers inside the detail panel and gives every pill field the same menu
 * edge, rather than letting each caller choose an initial side independently.
 */
export function getPropertyDropdownAlign(
  fieldVariant: FieldRowVariant
): Exclude<DropdownAlign, "auto"> {
  return fieldVariant === "pill" ? "right" : "left";
}

function useResolvedDropdownAlign(align: DropdownAlign) {
  const [autoAlign, setAutoAlign] = useState<"left" | "right">("left");
  // Auto alignment needs the rendered panel width. Keep the panel hidden
  // until its callback ref has resolved that width; otherwise it paints
  // left-aligned for one frame before moving to the right-aligned position.
  const [isAutoPositioned, setIsAutoPositioned] = useState(false);

  const dropdownRef = useCallback(
    (dropdown: HTMLDivElement | null) => {
      if (!dropdown) return;
      if (align !== "auto") return;

      const rect = dropdown.getBoundingClientRect();
      const viewportPadding = 12;
      const nextAlign =
        rect.right > getViewportSize().width - viewportPadding
          ? "right"
          : "left";
      setAutoAlign(nextAlign);
      setIsAutoPositioned(true);
    },
    [align]
  );

  return {
    dropdownRef,
    resolvedAlign: align === "auto" ? autoAlign : align,
    isPositioned: align !== "auto" || isAutoPositioned,
  };
}

export interface DropdownProps {
  children: React.ReactNode;
  className?: string;
  align?: DropdownAlign;
  widthMode?: DropdownWidthMode;
}

export const Dropdown: React.FC<DropdownProps> = ({
  children,
  className = "",
  align = "left",
  widthMode = "match-parent",
}) => {
  const { dropdownRef, resolvedAlign, isPositioned } =
    useResolvedDropdownAlign(align);
  const positionClass =
    widthMode === "menu"
      ? resolvedAlign === "right"
        ? "right-0"
        : "left-0"
      : resolvedAlign === "right"
        ? "right-2"
        : "left-2 right-2";
  const widthClass = widthMode === "menu" ? DROPDOWN_WIDTHS.wideMenuClass : "";

  return (
    <div
      ref={dropdownRef}
      data-property-dropdown
      className={`absolute ${positionClass} top-full mt-1 flex flex-col ${widthClass} ${DROPDOWN_CLASSES.panelAnimated} ${className}`}
      style={getPositionedOverlayVisibilityStyle(isPositioned)}
    >
      {children}
    </div>
  );
};

// ============================================
// SearchableDropdown - Dropdown with search input (relative positioning)
// ============================================

export interface SearchableDropdownProps {
  children: (searchQuery: string) => React.ReactNode;
  placeholder?: string;
  className?: string;
  maxHeight?: number;
  widthMode?: DropdownWidthMode;
  align?: DropdownAlign;
}

export const SearchableDropdown: React.FC<SearchableDropdownProps> = ({
  children,
  placeholder,
  className = "",
  maxHeight = DROPDOWN_PANEL.maxHeight,
  widthMode = "match-parent",
  align = "left",
}) => {
  const dropdownDirection = usePropertyDropdownDirection();
  const [searchQuery, setSearchQuery] = useState("");
  const [portalPosition, setPortalPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
    width?: number;
  } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const { dropdownRef, resolvedAlign, isPositioned } =
    useResolvedDropdownAlign(align);
  const positionClass =
    widthMode === "menu"
      ? resolvedAlign === "right"
        ? "right-0"
        : "left-0"
      : resolvedAlign === "right"
        ? "right-2"
        : "left-2 right-2";
  const widthClass = widthMode === "menu" ? DROPDOWN_WIDTHS.wideMenuClass : "";

  useLayoutEffect(() => {
    const updatePosition = () => {
      const anchorElement = anchorRef.current;
      if (!anchorElement) return;

      const rect = anchorElement.getBoundingClientRect();
      if (widthMode === "match-parent") {
        setPortalPosition({
          top: rect.top,
          left: rect.left,
          width: rect.width,
        });
        return;
      }

      const menuWidth = 200;
      const viewportPadding = 8;
      const { width: vw } = getViewportSize();
      const shouldAlignRight =
        resolvedAlign === "right" ||
        rect.left + menuWidth > vw - viewportPadding;

      setPortalPosition({
        top: rect.top,
        left: shouldAlignRight ? undefined : rect.left,
        right: shouldAlignRight
          ? Math.max(viewportPadding, vw - rect.right)
          : undefined,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [dropdownDirection, resolvedAlign, widthMode]);

  const dropdownContent = (
    <>
      <DropdownSearch
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={placeholder}
        autoFocus
      />
      <div className={DROPDOWN_CLASSES.optionsContainer} style={{ maxHeight }}>
        {children(searchQuery)}
      </div>
    </>
  );

  return (
    <>
      <div
        ref={anchorRef}
        className={`absolute ${positionClass} ${
          dropdownDirection === "up" ? "bottom-full mb-1" : "top-full mt-1"
        } h-0 ${widthMode === "menu" ? "w-0" : ""}`}
      />
      {portalPosition &&
        createPortal(
          <div
            ref={dropdownRef}
            data-property-dropdown
            className={`fixed flex flex-col ${widthClass} ${DROPDOWN_CLASSES.panelAnimated} ${className}`}
            style={{
              ...getPositionedOverlayVisibilityStyle(isPositioned),
              top: portalPosition.top,
              left: portalPosition.left,
              right: portalPosition.right,
              width: portalPosition.width,
              translate: dropdownDirection === "up" ? "0 -100%" : undefined,
            }}
          >
            {dropdownContent}
          </div>,
          document.body
        )}
    </>
  );
};

// ============================================
// Option - Single selectable option in dropdown
// ============================================

export interface OptionProps {
  icon?: React.ReactNode;
  iconColor?: string;
  label: string;
  isSelected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children?: React.ReactNode;
  /** Stable selector for rendered UI tests. */
  dataTestId?: string;
}

export const Option: React.FC<OptionProps> = ({
  icon,
  iconColor,
  label,
  isSelected,
  disabled = false,
  onClick,
  children,
  dataTestId,
}) => (
  <button
    type="button"
    data-testid={dataTestId}
    className={[
      DROPDOWN_CLASSES.item,
      !disabled && DROPDOWN_CLASSES.itemHover,
      "w-full justify-between text-left",
      isSelected && DROPDOWN_CLASSES.itemSelected,
      disabled && DROPDOWN_CLASSES.itemDisabled,
    ]
      .filter(Boolean)
      .join(" ")}
    onClick={onClick}
    disabled={disabled}
    aria-disabled={disabled}
  >
    {children ? (
      <>
        {children}
        {isSelected && <DropdownSelectedCheck className="ml-auto" />}
      </>
    ) : (
      <>
        {icon && (
          <span
            className={`flex shrink-0 items-center justify-center ${DROPDOWN_ITEM.iconSizeClass} [&_svg]:h-[13px] [&_svg]:w-[13px]`}
            style={iconColor ? { color: iconColor } : undefined}
          >
            {icon}
          </span>
        )}
        <span className="flex-1 truncate">{label}</span>
        {isSelected && <DropdownSelectedCheck />}
      </>
    )}
  </button>
);

// ============================================
// TextEditOption - Text area option in dropdown
// ============================================

export interface TextEditOptionProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  rows?: number;
}

export const TextEditOption: React.FC<TextEditOptionProps> = ({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = "Enter custom text...",
  rows = 3,
}) => {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit?.();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
    // Prevent dropdown from closing when typing
    event.stopPropagation();
  };

  return (
    <div className="px-2.5 py-2">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onClick={(event) => event.stopPropagation()}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-none rounded-md border border-border-2 bg-bg-1 px-2 py-1.5 text-xs text-text-1 transition-colors outline-none placeholder:text-text-3 focus:border-primary-6"
      />
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          <button
            onClick={(event) => {
              event.stopPropagation();
              onSubmit?.();
            }}
            className="rounded bg-primary-6 px-2 py-0.5 text-[11px] text-white transition-colors hover:bg-primary-5"
          >
            Save
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onCancel?.();
            }}
            className="rounded bg-fill-2 px-2 py-0.5 text-[11px] text-text-2 transition-colors hover:bg-fill-2"
          >
            Cancel
          </button>
        </div>
        <div className="text-[11px] text-text-3">
          {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter
        </div>
      </div>
    </div>
  );
};
