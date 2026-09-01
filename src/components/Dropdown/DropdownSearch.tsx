/**
 * DropdownSearch Component
 *
 * Search input for dropdowns with consistent styling.
 *
 * @example
 * ```tsx
 * import { DropdownSearch } from "@src/components/Dropdown";
 *
 * <DropdownPanel>
 *   <DropdownSearch
 *     value={searchValue}
 *     onChange={setSearchValue}
 *     placeholder="Search options..."
 *     autoFocus
 *   />
 *   <div className="p-1">
 *     {filteredOptions.map(opt => (
 *       <DropdownItem key={opt.value}>{opt.label}</DropdownItem>
 *     ))}
 *   </div>
 * </DropdownPanel>
 * ```
 */
import React, { forwardRef, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { HugeiconsIcon, Search01Icon } from "@src/icons";

import { DROPDOWN_CLASSES, DROPDOWN_SEARCH } from "./tokens";

type NativeSearchInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  | "aria-label"
  | "autoFocus"
  | "className"
  | "defaultValue"
  | "onChange"
  | "placeholder"
  | "value"
>;

export interface DropdownSearchProps extends NativeSearchInputProps {
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;

  /**
   * Search input value
   */
  value: string;

  /**
   * Change handler
   */
  onChange: (value: string) => void;

  /**
   * Placeholder text
   * @default Localized "Search"
   */
  placeholder?: string;

  /**
   * Accessible name when placeholder alone is insufficient
   */
  ariaLabel?: string;

  /**
   * Content before the input. Omit for the standard search icon or pass null
   * for an intentionally iconless field.
   */
  leading?: React.ReactNode;

  /** Additional classes for the shared search-row container. */
  containerClassName?: string;

  /** Test id applied to the shared search-row container. */
  testId?: string;

  /**
   * Auto-focus the input when mounted
   * @default false
   */
  autoFocus?: boolean;

  /**
   * When true (default), mousedown on the field does not bubble — keeps custom
   * droplist panels open when the user focuses the search input.
   * @default true
   */
  stopMouseDownPropagation?: boolean;
}

const DropdownSearch = forwardRef<HTMLInputElement, DropdownSearchProps>(
  (
    {
      value,
      onChange,
      placeholder,
      ariaLabel,
      leading,
      containerClassName,
      testId,
      autoFocus = false,
      stopMouseDownPropagation = true,
      type = "search",
      autoComplete = "off",
      autoCorrect = "off",
      autoCapitalize = "off",
      spellCheck = false,
      onClick,
      onMouseDown,
      onKeyDown,
      ...inputProps
    },
    ref
  ) => {
    const { t } = useTranslation("common");
    const internalRef = useRef<HTMLInputElement>(null);
    const tauriSelectAll = useTauriSelectAllShortcut();

    const setInputRef = useCallback(
      (element: HTMLInputElement | null) => {
        internalRef.current = element;
        if (typeof ref === "function") {
          ref(element);
        } else if (ref) {
          ref.current = element;
        }
      },
      [ref]
    );

    // Auto-focus handling
    useEffect(() => {
      if (autoFocus && internalRef.current) {
        // Small delay to ensure dropdown is rendered
        const timer = setTimeout(() => {
          internalRef.current?.focus();
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [autoFocus]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    };

    // Prevent dropdown from closing when clicking inside search
    const handlePointerGuard = (event: React.MouseEvent) => {
      event.stopPropagation();
    };

    const handleInputClick = (event: React.MouseEvent<HTMLInputElement>) => {
      handlePointerGuard(event);
      onClick?.(event);
    };

    const handleInputMouseDown = (
      event: React.MouseEvent<HTMLInputElement>
    ) => {
      if (stopMouseDownPropagation) handlePointerGuard(event);
      onMouseDown?.(event);
    };

    const handleInputKeyDown = (
      event: React.KeyboardEvent<HTMLInputElement>
    ) => {
      tauriSelectAll(event);
      if (!event.defaultPrevented) onKeyDown?.(event);
    };

    const handleContainerMouseDown = stopMouseDownPropagation
      ? handlePointerGuard
      : undefined;

    const resolvedPlaceholder = placeholder ?? t("actions.search");
    const resolvedLeading =
      leading === undefined ? (
        <HugeiconsIcon
          icon={Search01Icon}
          data-icon="search"
          size={DROPDOWN_SEARCH.iconSize}
          className="shrink-0 text-text-3"
        />
      ) : (
        leading
      );

    return (
      <div
        className={[DROPDOWN_CLASSES.searchContainer, containerClassName]
          .filter(Boolean)
          .join(" ")}
        data-testid={testId}
        onClick={handlePointerGuard}
        onMouseDown={handleContainerMouseDown}
      >
        {resolvedLeading}
        <input
          {...inputProps}
          ref={setInputRef}
          type={type}
          value={value}
          onChange={handleChange}
          onClick={handleInputClick}
          onMouseDown={handleInputMouseDown}
          onKeyDown={handleInputKeyDown}
          placeholder={resolvedPlaceholder}
          aria-label={ariaLabel ?? resolvedPlaceholder}
          autoComplete={autoComplete}
          autoCorrect={autoCorrect}
          autoCapitalize={autoCapitalize}
          spellCheck={spellCheck}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>
    );
  }
);

DropdownSearch.displayName = "DropdownSearch";

export default DropdownSearch;
