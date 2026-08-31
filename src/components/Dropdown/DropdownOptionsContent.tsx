import React from "react";
import { useTranslation } from "react-i18next";

import DropdownOptionsRenderer from "./DropdownOptionsRenderer";
import DropdownSearch from "./DropdownSearch";
import type { DropdownOption, DropdownSelectValue } from "./types";

interface DropdownOptionsContentProps {
  showSearch: boolean;
  searchPlaceholder?: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  filteredOptions: DropdownOption[];
  value?: DropdownSelectValue;
  mode: "single" | "multiple";
  highlightedIndex: number;
  keyboardNavigated: boolean;
  onSelect: (option: DropdownOption) => void;
  getOptionMouseEnterProps?: (index: number) => {
    "data-dropdown-keyboard-mode"?: "true";
    onMouseEnter: () => void;
  };
  loading: boolean;
  emptyContent?: React.ReactNode;
  dropdownRender?: (menu: React.ReactNode) => React.ReactNode;
}

const DropdownOptionsContent: React.FC<DropdownOptionsContentProps> = ({
  showSearch,
  searchPlaceholder,
  searchValue,
  onSearchChange,
  searchInputRef,
  filteredOptions,
  value,
  mode,
  highlightedIndex,
  keyboardNavigated,
  onSelect,
  getOptionMouseEnterProps,
  loading,
  emptyContent,
  dropdownRender,
}) => {
  const { t } = useTranslation();

  return (
    <>
      {showSearch && (
        <DropdownSearch
          ref={searchInputRef}
          type="text"
          placeholder={
            searchPlaceholder ?? t("common:common.searchPlaceholder")
          }
          value={searchValue}
          onChange={onSearchChange}
        />
      )}
      <DropdownOptionsRenderer
        options={filteredOptions}
        value={value}
        mode={mode}
        highlightedIndex={highlightedIndex}
        keyboardNavigated={keyboardNavigated}
        onSelect={onSelect}
        getOptionMouseEnterProps={getOptionMouseEnterProps}
        loading={loading}
        emptyContent={emptyContent}
        dropdownRender={dropdownRender}
      />
    </>
  );
};

export default DropdownOptionsContent;
