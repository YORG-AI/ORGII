/**
 * PropertyFieldEditable Component
 *
 * Reusable editable property field components used in properties panels
 * Extracted from WorkItem/Project PropertiesPanel pattern
 * Uses DROPDOWN_CLASSES and DropdownSearch for consistency with settings.
 */
import { ChevronDown, Pencil } from "lucide-react";
import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { getViewportSize } from "@src/util/ui/window/viewport";

// ============================================
// FieldRow - Interactive row that opens dropdowns
// ============================================

export type FieldRowVariant = "row" | "pill";

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
  borderless?: boolean;
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
  isActive,
  showChevron = true,
  usePencil = false,
  suffix,
  variant = "row",
  borderless = false,
  onClick,
}) => {
  const EditIcon = usePencil ? Pencil : ChevronDown;
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
          className={`max-w-[220px] ${pillBorderClass} ${
            isActive ? "!border-primary-6 !bg-fill-2 !text-primary-6" : ""
          }`}
          data-field-row
        >
          <span className={`min-w-0 truncate leading-[18px] ${valueClassName}`}>
            {value}
          </span>
          {suffix}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-8 w-full min-w-0 items-center gap-1 px-2 py-0.5">
      {label && (
        <span className="w-[72px] shrink-0 text-xs text-text-2">{label}</span>
      )}
      <div
        data-field-row
        className={`group/field flex min-w-0 flex-1 items-center rounded-md transition-colors hover:bg-surface-hover ${isActive ? "bg-surface-hover" : "bg-transparent"}`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent px-1.5 py-1.5 text-left outline-none"
          onClick={onClick}
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
            className={`mr-1 flex h-6 w-5 shrink-0 items-center justify-center rounded-md border-none bg-transparent text-text-3 ${isActive ? "flex" : "hidden group-hover/field:flex"}`}
          >
            <EditIcon size={DROPDOWN_ITEM.iconSize} />
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

function useResolvedDropdownAlign(align: DropdownAlign) {
  const [resolvedAlign, setResolvedAlign] = useState<"left" | "right">(
    align === "right" ? "right" : "left"
  );

  const dropdownRef = useCallback(
    (dropdown: HTMLDivElement | null) => {
      if (!dropdown) return;
      if (align !== "auto") {
        if (resolvedAlign !== align) setResolvedAlign(align);
        return;
      }

      const rect = dropdown.getBoundingClientRect();
      const viewportPadding = 12;
      const nextAlign =
        rect.right > getViewportSize().width - viewportPadding
          ? "right"
          : "left";
      if (resolvedAlign !== nextAlign) setResolvedAlign(nextAlign);
    },
    [align, resolvedAlign]
  );

  return { dropdownRef, resolvedAlign };
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
  const { dropdownRef, resolvedAlign } = useResolvedDropdownAlign(align);
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
  placeholder = "Search...",
  className = "",
  maxHeight = DROPDOWN_PANEL.maxHeight,
  widthMode = "match-parent",
  align = "left",
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [portalPosition, setPortalPosition] = useState<{
    top: number;
    left?: number;
    right?: number;
  } | null>(null);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const { dropdownRef, resolvedAlign } = useResolvedDropdownAlign(align);
  const shouldPortal = widthMode === "menu";

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
    if (!shouldPortal) return;

    const updatePosition = () => {
      const anchorElement = anchorRef.current;
      if (!anchorElement) return;

      const rect = anchorElement.getBoundingClientRect();
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
  }, [resolvedAlign, shouldPortal]);

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

  if (shouldPortal) {
    return (
      <>
        <div
          ref={anchorRef}
          className={`absolute ${positionClass} top-full mt-1 h-0 w-0`}
        />
        {portalPosition &&
          createPortal(
            <div
              ref={dropdownRef}
              data-property-dropdown
              className={`fixed flex flex-col ${widthClass} ${DROPDOWN_CLASSES.panelAnimated} ${className}`}
              style={{
                top: portalPosition.top,
                left: portalPosition.left,
                right: portalPosition.right,
              }}
            >
              {dropdownContent}
            </div>,
            document.body
          )}
      </>
    );
  }

  return (
    <div
      ref={dropdownRef}
      data-property-dropdown
      className={`absolute ${positionClass} top-full mt-1 flex flex-col ${widthClass} ${DROPDOWN_CLASSES.panelAnimated} ${className}`}
    >
      {dropdownContent}
    </div>
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
  onClick,
  children,
  dataTestId,
}) => (
  <button
    type="button"
    data-testid={dataTestId}
    className={[
      DROPDOWN_CLASSES.item,
      DROPDOWN_CLASSES.itemHover,
      "w-full justify-between text-left",
      isSelected && DROPDOWN_CLASSES.itemSelected,
    ]
      .filter(Boolean)
      .join(" ")}
    onClick={onClick}
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
        className="w-full resize-none rounded-md border border-border-2 bg-bg-1 px-2 py-1.5 text-xs text-text-1 placeholder-text-3 outline-none transition-colors focus:border-primary-6"
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
