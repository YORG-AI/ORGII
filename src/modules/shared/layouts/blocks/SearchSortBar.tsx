import { Filter, Search } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input, { type InputProps } from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";

export interface SearchSortBarFilterConfig {
  pills: React.ReactNode;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
  title?: string;
}

export interface SearchSortBarProps {
  searchValue?: string;
  searchPlaceholder?: string;
  searchInputSize?: InputProps["size"];
  onSearchChange?: (value: string) => void;
  onSearchClear?: () => void;
  sortValue?: string;
  sortOptions?: SelectOption[];
  onSortChange?: (value: string | number | (string | number)[]) => void;
  searchCountText?: string;
  sortWidthClassName?: string;
  leftContent?: React.ReactNode;
  rightContent?: React.ReactNode;
  allowSearchClear?: boolean;
  /** Tab pills rendered inline with searchCountText (pills left, count right) */
  tabPills?: React.ReactNode;
  /** Filter button + collapsible pills. When provided, renders Filter button and pills when expanded. */
  filterConfig?: SearchSortBarFilterConfig;
  /** Strip horizontal padding (for consumers that provide their own outer px) */
  noPadding?: boolean;
}

const SearchSortBar: React.FC<SearchSortBarProps> = ({
  searchValue,
  searchPlaceholder,
  searchInputSize,
  onSearchChange,
  onSearchClear,
  sortValue,
  sortOptions,
  onSortChange,
  searchCountText,
  sortWidthClassName = "w-[180px]",
  leftContent,
  rightContent,
  allowSearchClear = true,
  tabPills,
  filterConfig,
  noPadding = false,
}) => {
  const { t } = useTranslation();
  const showSort =
    typeof sortValue === "string" &&
    Array.isArray(sortOptions) &&
    sortOptions.length > 0 &&
    typeof onSortChange === "function";

  const hasSearchInput =
    searchValue !== undefined &&
    searchPlaceholder !== undefined &&
    typeof onSearchChange === "function";

  const effectiveRightContent =
    rightContent ??
    (filterConfig ? (
      <Button
        variant="secondary"
        iconOnly
        onClick={filterConfig.onToggle}
        icon={
          <Filter
            size={14}
            className={filterConfig.active ? "text-primary-6" : ""}
          />
        }
        title={filterConfig.title ?? t("labels.filter")}
      />
    ) : undefined);

  const effectiveTabPills = filterConfig?.expanded
    ? filterConfig.pills
    : tabPills;

  const showTopRow =
    hasSearchInput || !!leftContent || !!effectiveRightContent || showSort;
  const tabPillsRowClassName = `min-w-0 flex-shrink-0 overflow-x-auto overflow-y-hidden pb-2 ${showTopRow ? "" : "pt-2"} ${noPadding ? "" : "px-4"}`;

  return (
    <>
      {showTopRow && (
        <div className={`flex-shrink-0 pb-2 pt-2 ${noPadding ? "" : "px-4"}`}>
          <div className="flex items-center gap-1.5">
            {leftContent}
            {hasSearchInput && (
              <div className="min-w-0 flex-1">
                <Input
                  className="w-full min-w-0"
                  type="search"
                  size={searchInputSize}
                  value={searchValue}
                  placeholder={searchPlaceholder}
                  prefix={
                    <Search size={14} className="text-text-3" aria-hidden />
                  }
                  onChange={(value) => onSearchChange(value)}
                  allowClear={allowSearchClear}
                  onClear={onSearchClear}
                />
              </div>
            )}
            {effectiveRightContent}
            {!rightContent && showSort && (
              <div className={sortWidthClassName}>
                <Select
                  value={sortValue}
                  onChange={onSortChange}
                  options={sortOptions}
                />
              </div>
            )}
          </div>
        </div>
      )}
      {(searchCountText || effectiveTabPills) && (
        <div className={tabPillsRowClassName}>
          <div className="flex w-max min-w-full items-center gap-2">
            {effectiveTabPills && (
              <div className="min-w-0 shrink-0">{effectiveTabPills}</div>
            )}
            {searchCountText && (
              <span className="shrink-0 pl-2 text-[13px] font-semibold text-text-1">
                {searchCountText}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default SearchSortBar;
