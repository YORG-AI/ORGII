/**
 * SearchBar Component
 *
 * Shared-styled search controls for the search editor tab.
 * Uses the same reusable input/select components as other tabs.
 */
import { Loader2 } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { SEARCH_TAB_ROW_CLASSES } from "@src/modules/WorkStation/shared/tokens";

import { SearchInput, SearchModeSelect } from "../../../shared";
import type { SearchBarProps } from "./types";

export const SearchBar: React.FC<SearchBarProps> = memo(
  ({
    query,
    onQueryChange,
    mode,
    onModeChange,
    advancedAvailable = false,
    isLoading = false,
    caseSensitive,
    wholeWord,
    useRegex,
    onCaseSensitiveToggle,
    onWholeWordToggle,
    onRegexToggle,
    rightAction,
    className = "",
  }) => {
    const { t } = useTranslation();

    return (
      <div className={`${SEARCH_TAB_ROW_CLASSES.row} ${className}`}>
        <SearchModeSelect
          value={mode}
          onChange={onModeChange}
          advancedAvailable={advancedAvailable}
          disabled={isLoading}
          size="small"
          appearance="default"
          className="w-[168px]"
        />

        <SearchInput
          value={query}
          onChange={onQueryChange}
          placeholder={t("placeholders.searchInRepository")}
          variant="sidebar"
          hideChevron={true}
          showClearButton={true}
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          useRegex={useRegex}
          onCaseSensitiveToggle={onCaseSensitiveToggle}
          onWholeWordToggle={onWholeWordToggle}
          onRegexToggle={onRegexToggle}
          className="flex-1"
        />

        {rightAction}

        {isLoading && (
          <Loader2
            size={SPINNER_TOKENS.default}
            className="animate-spin text-text-3"
          />
        )}
      </div>
    );
  }
);

SearchBar.displayName = "SearchBar";

export default SearchBar;
