/**
 * ChatSearchBar Component
 *
 * "Find in chat" search bar reusing the shared SearchInput component
 * (same as TerminalSearchPanel) for visual consistency.
 *
 * Features:
 * - Case-sensitive, whole-word & regex toggle buttons
 * - Result count and up/down navigation
 * - Escape to close
 */
import { X } from "lucide-react";
import {
  type RefObject,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";

import type { UseChatSearchReturn } from "../hooks/useChatSearch";

// ============================================
// Types
// ============================================

export interface ChatSearchBarProps {
  /** Search state from useChatSearch hook */
  search: UseChatSearchReturn;
  /** Callback when search bar is closed */
  onClose?: () => void;
  /** Whether the search bar is visible */
  isVisible: boolean;
}

export interface ChatSearchBarHandle {
  /** Focus the search input */
  focus: () => void;
}

// ============================================
// Component
// ============================================

export const ChatSearchBar = forwardRef<
  ChatSearchBarHandle | null,
  ChatSearchBarProps
>(function ChatSearchBar({ search, onClose, isVisible }, ref) {
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
    clearSearch,
    caseSensitive,
    toggleCaseSensitive,
    useRegex,
    toggleRegex,
    wholeWord,
    toggleWholeWord,
  } = search;

  // Expose focus method
  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  // Focus input when visible
  useEffect(() => {
    if (isVisible) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isVisible]);

  // Handle Escape to close
  useEffect(() => {
    if (!isVisible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        clearSearch();
        onClose?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isVisible, clearSearch, onClose]);

  // Handle close button
  const handleClose = useCallback(() => {
    clearSearch();
    onClose?.();
  }, [clearSearch, onClose]);

  // Handle Enter → next result
  const handleSubmit = useCallback(() => {
    nextResult();
  }, [nextResult]);

  if (!isVisible) return null;

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

      {/* Result count */}
      <span className="min-w-[56px] shrink-0 text-center text-xs text-text-3">
        {!query
          ? ""
          : isSearching
            ? "..."
            : resultCount > 0
              ? `${currentResultIndex + 1} / ${resultCount}`
              : t("chat.noResults")}
      </span>

      {/* Close button — pushed to the right end */}
      <div className="flex flex-1 justify-end">
        <button
          onClick={handleClose}
          className="flex h-5 w-5 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-3 hover:text-text-1"
          title={t("chat.closeEsc")}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
});

export default ChatSearchBar;
