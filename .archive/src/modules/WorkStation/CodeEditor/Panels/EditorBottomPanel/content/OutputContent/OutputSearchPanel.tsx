/**
 * Output Search Panel
 *
 * Find-in-output search bar using the shared SearchInput component.
 * Same UX as TerminalSearchPanel, with a match counter badge.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";

import type { OutputSearchOptions, OutputSearchState } from "./useOutputSearch";

// ============================================
// Types
// ============================================

export interface OutputSearchPanelProps {
  /** Whether the search panel is visible */
  isOpen: boolean;
  /** Callback to close the search panel */
  onClose: () => void;
  /** Search next match */
  onFindNext: (query: string, options: OutputSearchOptions) => void;
  /** Search previous match */
  onFindPrevious: (query: string, options: OutputSearchOptions) => void;
  /** Clear search highlights */
  onClearSearch: () => void;
  /** Current search state (match count, active index) */
  searchState: OutputSearchState;
}

// ============================================
// Component
// ============================================

export const OutputSearchPanel: React.FC<OutputSearchPanelProps> = memo(
  ({
    isOpen,
    onClose,
    onFindNext,
    onFindPrevious,
    onClearSearch,
    searchState,
  }) => {
    const { t } = useTranslation();
    const [query, setQuery] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    // Focus input when panel opens
    useEffect(() => {
      if (isOpen) {
        setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 50);
      }
    }, [isOpen]);

    // Clear search when query is emptied
    useEffect(() => {
      if (!query) {
        onClearSearch();
      }
    }, [query, onClearSearch]);

    // Keyboard shortcuts
    useEffect(() => {
      if (!isOpen) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClearSearch();
          onClose();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, onClose, onClearSearch]);

    const searchOptions: OutputSearchOptions = useMemo(
      () => ({
        caseSensitive,
        wholeWord,
        regex: useRegex,
      }),
      [caseSensitive, wholeWord, useRegex]
    );

    const handleFindNext = useCallback(() => {
      if (query) {
        onFindNext(query, searchOptions);
      }
    }, [query, searchOptions, onFindNext]);

    const handleFindPrevious = useCallback(() => {
      if (query) {
        onFindPrevious(query, searchOptions);
      }
    }, [query, searchOptions, onFindPrevious]);

    const handleClose = useCallback(() => {
      onClearSearch();
      onClose();
    }, [onClearSearch, onClose]);

    const handleSubmit = useCallback(() => {
      handleFindNext();
    }, [handleFindNext]);

    const repeatSearchForOptions = useEffectEvent(() => {
      if (query && isOpen) {
        onFindNext(query, { caseSensitive, wholeWord, regex: useRegex });
      }
    });

    // Re-search when options change
    useEffect(() => {
      repeatSearchForOptions();
    }, [caseSensitive, wholeWord, useRegex]);

    if (!isOpen) return null;

    return (
      <div className="flex items-center gap-2 border-b border-border-2 px-3 py-1.5">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={t("common:actions.search")}
          variant="panel"
          caseSensitive={caseSensitive}
          wholeWord={wholeWord}
          useRegex={useRegex}
          onCaseSensitiveToggle={() => setCaseSensitive(!caseSensitive)}
          onWholeWordToggle={() => setWholeWord(!wholeWord)}
          onRegexToggle={() => setUseRegex(!useRegex)}
          onPrevious={handleFindPrevious}
          onNext={handleFindNext}
          onClose={handleClose}
          onSubmit={handleSubmit}
          inputRef={inputRef as React.RefObject<HTMLInputElement>}
          hideChevron
          className="flex-1"
        />

        {/* Match counter */}
        {query && (
          <span className="whitespace-nowrap text-[12px] text-text-3">
            {searchState.matchCount > 0
              ? `${searchState.activeIndex}/${searchState.matchCount}`
              : t("common:status.noResults")}
          </span>
        )}
      </div>
    );
  }
);

OutputSearchPanel.displayName = "OutputSearchPanel";

export default OutputSearchPanel;
