/**
 * ChatSearchBar Component
 *
 * "Find in chat" search bar reusing the shared SearchInput component
 * (same as TerminalSearchPanel) for visual consistency.
 */
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

import type { UseChatSearchReturn } from "../hooks/useChatSearch";

export interface ChatSearchBarProps {
  search: UseChatSearchReturn;
}

export function ChatSearchBar({ search }: ChatSearchBarProps) {
  const { t } = useTranslation("sessions");
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    query,
    setQuery,
    isSearching,
    resultCount,
    currentResultIndex,
    nextResult,
    prevResult,
    closeSearch,
    isSearchVisible,
    caseSensitive,
    toggleCaseSensitive,
    useRegex,
    toggleRegex,
    wholeWord,
    toggleWholeWord,
  } = search;

  useEffect(() => {
    if (!isSearchVisible) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, [isSearchVisible]);

  useEffect(() => {
    if (!isSearchVisible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSearchVisible, closeSearch]);

  const handleSubmit = useCallback(() => {
    nextResult();
  }, [nextResult]);

  if (!isSearchVisible) return null;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <SearchInput
        value={query}
        onChange={setQuery}
        placeholder={t("chat.findInChat")}
        variant="panel"
        caseSensitive={caseSensitive}
        wholeWord={wholeWord}
        useRegex={useRegex}
        onCaseSensitiveToggle={toggleCaseSensitive}
        onWholeWordToggle={toggleWholeWord}
        onRegexToggle={toggleRegex}
        onPrevious={prevResult}
        onNext={nextResult}
        onSubmit={handleSubmit}
        inputRef={inputRef as RefObject<HTMLInputElement>}
        hideChevron
        inputBoxClassName="flex-none w-full max-w-[240px]"
      />

      <span className="min-w-[56px] shrink-0 text-center text-xs text-text-3">
        {!query
          ? ""
          : isSearching
            ? "..."
            : resultCount > 0
              ? `${currentResultIndex + 1} / ${resultCount}`
              : t("chat.noResults")}
      </span>

      <div className="flex flex-1 justify-end">
        <button
          onClick={closeSearch}
          className="flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-3 hover:text-text-1"
          title={t("chat.closeEsc")}
        >
          <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={14} />
        </button>
      </div>
    </div>
  );
}

export default ChatSearchBar;
