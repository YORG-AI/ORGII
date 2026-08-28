/**
 * PaletteBody
 *
 * Pure-content body for a palette: search bar + top slot + hint slot +
 * item list + after-list slot.
 *
 * NO chrome, portal, or footer. The enclosing SpotlightShell owns those
 * concerns. Palettes render <SpotlightShell>
 * <PaletteBody ... /></SpotlightShell>.
 */
import React from "react";

import { type IconSvgElement } from "@src/icons";

import { SpotlightItemList, SpotlightSearchBar } from "../components";
import type { UseSelectorReturn } from "../hooks/selectors/useSelector";
import { SpotlightInput } from "../shared";
import type { PathSegment, SpotlightItem } from "../types";

// ============ TYPES ============

export interface PaletteBodyProps {
  kernel: UseSelectorReturn;
  items: SpotlightItem[];
  /**
   * Optional override for the rendered query string. When omitted,
   * `kernel.searchQuery` is used — that already resolves to the
   * external source if the caller supplied one. Pass an explicit value
   * only when the rendered string must differ from what drives keyboard
   * filtering (rare).
   */
  searchQuery?: string;
  placeholder: string;
  /** Accessible name forwarded to the simple input variant. */
  inputAriaLabel?: string;

  /** "searchBar" (default, breadcrumb-style) or "simple" (icon prefix). */
  inputVariant?: "searchBar" | "simple";

  // searchBar variant
  path?: PathSegment[];
  onRemoveSegment?: (index: number) => void;

  // simple variant
  inputIcon?: IconSvgElement;
  inputIconElement?: React.ReactNode;
  /** Shown inside the search row before the input (searchBar variant only). */
  inputLeadingSlot?: React.ReactNode;
  /** Shown inside the search row on the right (simple variant only) */
  inputTrailingSlot?: React.ReactNode;

  isLoading?: boolean;
  containerHeight?: number;
  fixedHeight?: boolean;
  hideActionClose?: boolean;

  topSlot?: React.ReactNode;
  hintSlot?: React.ReactNode;
  contentOverride?: React.ReactNode | null;
  afterListSlot?: React.ReactNode;
}

// ============ COMPONENT ============

export const PaletteBody: React.FC<PaletteBodyProps> = ({
  kernel,
  items,
  searchQuery: searchQueryOverride,
  placeholder,
  inputAriaLabel,
  inputVariant = "searchBar",
  path = [],
  onRemoveSegment,
  inputIcon,
  inputIconElement,
  inputLeadingSlot,
  inputTrailingSlot,
  isLoading = false,
  containerHeight = 350,
  fixedHeight = false,
  hideActionClose = false,
  topSlot,
  hintSlot,
  contentOverride,
  afterListSlot,
}) => {
  const searchQuery = searchQueryOverride ?? kernel.searchQuery;
  return (
    <>
      {inputVariant === "simple" ? (
        <SpotlightInput
          inputRef={kernel.inputRef}
          value={searchQuery}
          onChange={(value) => kernel.setSearchQuery(value)}
          onKeyDown={kernel.handleKeyDown}
          placeholder={placeholder}
          ariaLabel={inputAriaLabel}
          isLoading={isLoading}
          icon={inputIcon}
          iconElement={inputIconElement}
          trailingSlot={inputTrailingSlot}
        />
      ) : (
        <SpotlightSearchBar
          inputRef={kernel.inputRef}
          searchQuery={searchQuery}
          onSearchQueryChange={(value) => kernel.setSearchQuery(value)}
          onKeyDown={kernel.handleKeyDown}
          placeholder={placeholder}
          ariaLabel={inputAriaLabel}
          isLoading={isLoading}
          isCountingDown={false}
          hideActionClose={hideActionClose}
          leadingSlot={inputLeadingSlot}
          trailingSlot={inputTrailingSlot}
          path={path}
          onRemoveSegment={onRemoveSegment}
        />
      )}

      {topSlot}
      {hintSlot}

      {contentOverride !== undefined ? (
        contentOverride
      ) : (
        <SpotlightItemList
          items={items}
          selectedIndex={kernel.selectedIndex}
          onItemSelect={kernel.handleItemClick}
          onItemHover={kernel.setSelectedIndex}
          searchQuery={searchQuery}
          containerHeight={containerHeight}
          isLoadingInitial={isLoading}
          fixedHeight={fixedHeight}
        />
      )}

      {afterListSlot}
    </>
  );
};

export default PaletteBody;
