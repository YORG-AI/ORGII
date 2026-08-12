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
import { Search } from "lucide-react";
import React, { forwardRef, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";

import { DROPDOWN_CLASSES, DROPDOWN_SEARCH } from "./tokens";

export interface DropdownSearchProps {
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
      autoFocus = false,
      stopMouseDownPropagation = true,
    },
    ref
  ) => {
    const { t } = useTranslation("common");
    const internalRef = useRef<HTMLInputElement>(null);
    const inputRef = (ref as React.RefObject<HTMLInputElement>) || internalRef;
    const tauriSelectAll = useTauriSelectAllShortcut();

    // Auto-focus handling
    useEffect(() => {
      if (autoFocus && inputRef.current) {
        // Small delay to ensure dropdown is rendered
        const timer = setTimeout(() => {
          inputRef.current?.focus();
        }, 10);
        return () => clearTimeout(timer);
      }
    }, [autoFocus, inputRef]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange(e.target.value);
    };

    // Prevent dropdown from closing when clicking inside search
    const handlePointerGuard = (event: React.MouseEvent) => {
      event.stopPropagation();
    };

    const handleMouseDown = stopMouseDownPropagation
      ? handlePointerGuard
      : undefined;

    const resolvedPlaceholder = placeholder ?? t("actions.search");

    return (
      <div
        className={DROPDOWN_CLASSES.searchContainer}
        onClick={handlePointerGuard}
        onMouseDown={handleMouseDown}
      >
        <Search
          size={DROPDOWN_SEARCH.iconSize}
          className="flex-shrink-0 text-text-3"
        />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={handleChange}
          onClick={handlePointerGuard}
          onMouseDown={handleMouseDown}
          onKeyDown={tauriSelectAll}
          placeholder={resolvedPlaceholder}
          aria-label={ariaLabel ?? resolvedPlaceholder}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>
    );
  }
);

DropdownSearch.displayName = "DropdownSearch";

export default DropdownSearch;
