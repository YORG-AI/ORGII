/**
 * DropdownItem Component
 *
 * Base dropdown item with consistent styling.
 * Use this for menu items, select options, etc.
 *
 * @example
 * ```tsx
 * import { DropdownItem } from "@src/components/Dropdown";
 *
 * // Basic usage
 * <DropdownItem onClick={() => handleSelect("option1")}>
 *   Option 1
 * </DropdownItem>
 *
 * // With icon and selected state
 * <DropdownItem
 *   icon={<HugeiconsIcon icon={Settings} size={DROPDOWN_ITEM.iconSize} />}
 *   selected={currentValue === "settings"}
 *   onClick={() => handleSelect("settings")}
 * >
 *   Settings
 * </DropdownItem>
 *
 * // With suffix (e.g., checkmark, shortcut)
 * <DropdownItem
 *   suffix={<HugeiconsIcon icon={Check} size={DROPDOWN_ITEM.iconSize} />}
 *   selected
 * >
 *   Selected Option
 * </DropdownItem>
 * ```
 */
import React, { forwardRef, memo } from "react";

import { HugeiconsIcon, Tick01Icon } from "@src/icons";

import DropdownSelectedCheck from "./DropdownSelectedCheck";
import { DROPDOWN_CLASSES, DROPDOWN_ITEM } from "./tokens";

export interface DropdownItemProps {
  /** DOM id, used by comboboxes for aria-activedescendant. */
  id?: string;

  /** Index hook used by shared dropdown keyboard navigation autoscroll. */
  dataDropdownItemIndex?: number;

  /**
   * Item content/label
   */
  children: React.ReactNode;

  /**
   * Icon element (displayed before label)
   */
  icon?: React.ReactNode;

  /**
   * Suffix element (displayed after label, e.g., checkmark, shortcut)
   */
  suffix?: React.ReactNode;

  /**
   * Whether this item is selected
   * @default false
   */
  selected?: boolean;

  /**
   * Whether to show a checkmark when `selected`. Defaults to `true` because
   * the selected state no longer has a background fill — the checkmark is now
   * the primary selected indicator. A caller-supplied `suffix` always takes
   * precedence over the trailing checkmark.
   * @default true
   */
  showCheckmark?: boolean;

  /**
   * Controls where the selected check appears. Defaults to the existing
   * trailing placement; `icon` replaces the leading icon with a check.
   * @default "trailing"
   */
  selectedCheckPlacement?: "trailing" | "icon";

  /**
   * Whether this item is disabled
   * @default false
   */
  disabled?: boolean;

  /**
   * Whether this item is highlighted (keyboard navigation)
   * @default false
   */
  highlighted?: boolean;

  /**
   * Click handler
   */
  onClick?: () => void;

  /**
   * Mouse enter handler (for hover/highlight)
   */
  onMouseEnter?: () => void;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Stable selector for rendered UI tests.
   */
  dataTestId?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * ARIA role for the row. Defaults to "option" for listbox-style dropdowns.
   * Use "menuitem" for action/command menus (context menus, header menus).
   * @default "option"
   */
  role?: React.AriaRole;

  /**
   * Full-width action-row layout (w-full, left-aligned, single line). Use for
   * command/action menu rows that previously used a raw `<button>` +
   * `DROPDOWN_CLASSES.menuActionItem`.
   * @default false
   */
  fullWidth?: boolean;

  /**
   * Tab index. Provide `0` to make a standalone action row directly
   * keyboard-focusable (menus without a listbox roving-focus manager). Omitted
   * by default so listbox options keep parent-managed focus behavior.
   */
  tabIndex?: number;

  /**
   * Accessible name for rows without readable text content (icon-only rows).
   */
  ariaLabel?: string;

  /**
   * `aria-haspopup` for rows that open a submenu / flyout.
   */
  ariaHasPopup?: React.AriaAttributes["aria-haspopup"];

  /**
   * `aria-expanded` for submenu-trigger rows.
   */
  ariaExpanded?: boolean;
  /** Checked state for menu radio items. */
  ariaChecked?: React.AriaAttributes["aria-checked"];
}

const DropdownItemInner = forwardRef<HTMLDivElement, DropdownItemProps>(
  (
    {
      id,
      dataDropdownItemIndex,
      children,
      icon,
      suffix,
      selected = false,
      showCheckmark = true,
      selectedCheckPlacement = "trailing",
      disabled = false,
      highlighted = false,
      onClick,
      onMouseEnter,
      className = "",
      dataTestId,
      style,
      role = "option",
      fullWidth = false,
      tabIndex,
      ariaLabel,
      ariaHasPopup,
      ariaExpanded,
      ariaChecked,
    },
    ref
  ) => {
    const handleClick = () => {
      if (disabled) return;
      onClick?.();
    };

    // Keyboard activation for directly-focusable rows (action/command menus
    // without a listbox roving-focus manager). No-op for parent-managed
    // listbox options: they don't set `tabIndex`, so the row never gains focus
    // and never receives these key events.
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick?.();
      }
    };

    const itemClasses = [
      DROPDOWN_CLASSES.item,
      fullWidth && "w-full justify-start whitespace-nowrap text-left",
      !disabled && DROPDOWN_CLASSES.itemHover,
      // Only keyboard `highlighted` gets a filled background. The `selected`
      // state is shown by the checkmark + primary-6 text only (no bg fill).
      highlighted && !disabled && "bg-fill-2",
      selected && DROPDOWN_CLASSES.itemSelected,
      disabled && DROPDOWN_CLASSES.itemDisabled,
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const effectiveTabIndex =
      tabIndex === undefined ? undefined : disabled ? -1 : tabIndex;

    return (
      <div
        ref={ref}
        id={id}
        className={itemClasses}
        data-dropdown-item-index={dataDropdownItemIndex}
        data-testid={dataTestId}
        style={style}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseEnter={onMouseEnter}
        role={role}
        tabIndex={effectiveTabIndex}
        aria-label={ariaLabel}
        aria-haspopup={ariaHasPopup}
        aria-expanded={ariaExpanded}
        aria-checked={ariaChecked}
        aria-selected={role === "option" ? selected : undefined}
        aria-disabled={disabled}
      >
        {/* Icon */}
        {icon && (
          <span
            className={`shrink-0 ${selected ? "text-primary-6" : "text-text-2"}`}
          >
            {showCheckmark && selected && selectedCheckPlacement === "icon" ? (
              <HugeiconsIcon
                icon={Tick01Icon}
                data-icon="check"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={2.25}
                className="shrink-0 text-primary-6"
              />
            ) : (
              icon
            )}
          </span>
        )}

        {/* Label */}
        <span className={`flex-1 truncate ${selected ? "text-primary-6" : ""}`}>
          {children}
        </span>

        {/* Suffix or Checkmark */}
        {(suffix ||
          (showCheckmark &&
            selected &&
            selectedCheckPlacement === "trailing")) && (
          <span
            className={`shrink-0 ${selected ? "text-primary-6" : "text-text-3"}`}
          >
            {suffix || (showCheckmark && selected && <DropdownSelectedCheck />)}
          </span>
        )}
      </div>
    );
  }
);

DropdownItemInner.displayName = "DropdownItem";

// Memoize to prevent unnecessary re-renders in dropdown lists
const DropdownItem = memo(DropdownItemInner);

export default DropdownItem;

// ==============================================
// DropdownItemGroup - For grouped items
// ==============================================

export interface DropdownItemGroupProps {
  /**
   * Group label
   */
  label: string;

  /**
   * Group items
   */
  children: React.ReactNode;

  /**
   * Additional class name
   */
  className?: string;
}

export const DropdownItemGroup: React.FC<DropdownItemGroupProps> = ({
  label,
  children,
  className = "",
}) => {
  return (
    <div className={className}>
      <div className={DROPDOWN_CLASSES.sectionLabel}>{label}</div>
      {children}
    </div>
  );
};

DropdownItemGroup.displayName = "DropdownItemGroup";
