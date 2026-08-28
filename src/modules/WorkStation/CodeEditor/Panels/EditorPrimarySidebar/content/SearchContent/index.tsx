/**
 * SearchContent Component
 *
 * VSCode-style find/replace panel with inline options.
 * Displays search results in a flat list format with virtualization:
 * - File (header with match count)
 *   - Line result (indented)
 *   - Line result (indented)
 *
 * Uses VirtualizedStickyTree for consistent behavior with file explorer.
 *
 * Exposes methods via ref:
 * - collapseAll(): Collapse all search result file headers
 */
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtomValue, useSetAtom } from "jotai";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  SquareArrowUpRightIcon,
} from "@src/icons";
import { HUMANTOOLS_TEXT_KEYS } from "@src/modules/WorkStation/shared";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import { workStationSearchFocusSignalAtom } from "@src/store/ui/workStationAtom";
import {
  searchOptionsAtom,
  searchQueryAtom,
} from "@src/store/workstation/codeEditor/search";
import {
  createSearchTab,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

import {
  ReplaceInput,
  SearchFilters,
  SearchInput,
  type SearchMode,
  SearchModeSelect,
} from "../../../shared";
import { SearchResults, type SearchResultsHandle } from "./components";
import { SEARCH_CONSTANTS } from "./config";
import type { SearchContentHandle, SearchContentProps } from "./types";
import { useSearchContent } from "./useSearchContent";

const log = createLogger("SearchContent");

// ============================================
// Main Component
// ============================================

export const SearchContent = forwardRef<
  SearchContentHandle,
  SearchContentProps
>(
  (
    {
      repoPath,
      onResultClick,
      openFiles = [],
      showFilters = false,
      onOpenInTab,
    },
    ref
  ) => {
    const { t } = useTranslation();
    // Store access for opening search in main tab
    const setLayout = useSetAtom(workstationLayoutAtom);
    const searchFocusSignal = useAtomValue(workStationSearchFocusSignalAtom);
    const sidebarSearchQuery = useAtomValue(searchQueryAtom);
    const sidebarSearchOptions = useAtomValue(searchOptionsAtom);
    const searchInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

    // Handle opening search in a main editor tab
    const handleOpenInTab = useCallback(() => {
      if (onOpenInTab) {
        onOpenInTab();
        return;
      }

      // Fallback: directly open search tab using store
      const tab = createSearchTab(repoPath, {
        query: sidebarSearchQuery,
        options: sidebarSearchOptions,
      });
      setLayout((prev) => ({
        ...prev,
        mainPane: openTab(
          prev?.mainPane ?? { tabs: [], activeTabId: null },
          tab
        ),
      }));
    }, [
      onOpenInTab,
      repoPath,
      setLayout,
      sidebarSearchQuery,
      sidebarSearchOptions,
    ]);

    // Search mode state - must be defined before hook call
    const [searchMode, setSearchMode] = useState<SearchMode>("regex");
    const [replaceText, setReplaceText] = useState("");
    const [showReplace, setShowReplace] = useState(false);

    const {
      query,
      setQuery,
      options,
      setOptions,
      results,
      loading,
      loadingMore,
      error,
      totalMatches: _totalMatches,
      totalFiles: _totalFiles,
      actualTotalMatches,
      actualTotalFiles,
      hasMore,
      isTruncated,
      loadMore,
    } = useSearchContent({ repoPath, openFiles, searchMode });

    useEffect(() => {
      if (searchFocusSignal === 0) return;
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, [searchFocusSignal]);

    // Delay showing "no results" / "error" by 2s so fast searches don't flash.
    // Search is typically fast (<200ms), so we only show the empty/error state
    // if the user is genuinely stuck — not during the brief loading window.
    //
    // Pattern: timer sets a key in an async callback (not synchronous setState
    // in the effect body). The render-time check `feedbackQuery === query`
    // auto-hides stale feedback when query/loading/results change.
    const [feedbackQuery, setFeedbackQuery] = useState("");
    useEffect(() => {
      if (loading || results.length > 0 || !query.trim()) return;
      const timer = setTimeout(() => {
        setFeedbackQuery(query);
      }, 2000);
      return () => clearTimeout(timer);
    }, [loading, results.length, query]);

    const showFeedback =
      feedbackQuery === query && !loading && results.length === 0;

    // Ref to SearchResults for collapse/expand control
    const searchResultsRef = useRef<SearchResultsHandle>(null);

    // Expose collapse method via ref
    useImperativeHandle(
      ref,
      () => ({
        collapseAll: () => {
          searchResultsRef.current?.collapseAll();
        },
      }),
      []
    );

    // Note: Infinite scroll is handled by Virtuoso's endReached callback

    const handleCaseSensitiveToggle = useCallback(() => {
      setOptions({ caseSensitive: !options.caseSensitive });
    }, [options.caseSensitive, setOptions]);

    const handleWholeWordToggle = useCallback(() => {
      setOptions({ wholeWord: !options.wholeWord });
    }, [options.wholeWord, setOptions]);

    const handleRegexToggle = useCallback(() => {
      setOptions({ useRegex: !options.useRegex });
    }, [options.useRegex, setOptions]);

    const handleExpandToggle = useCallback(() => {
      setShowReplace((prev) => !prev);
    }, []);

    const [isReplacingAll, setIsReplacingAll] = useState(false);

    const handleReplaceAll = useCallback(async () => {
      if (
        !query.trim() ||
        !replaceText ||
        results.length === 0 ||
        isReplacingAll
      )
        return;
      setIsReplacingAll(true);
      try {
        for (const file of results) {
          try {
            const content = await readTextFile(file.file_path);
            let updated: string;
            if (options.useRegex) {
              const flags = options.caseSensitive ? "g" : "gi";
              updated = content.replace(new RegExp(query, flags), replaceText);
            } else {
              const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
              const flags = options.caseSensitive ? "g" : "gi";
              const boundary = options.wholeWord ? `\\b${escaped}\\b` : escaped;
              updated = content.replace(
                new RegExp(boundary, flags),
                replaceText
              );
            }
            if (updated !== content) {
              await writeTextFile(file.file_path, updated);
            }
          } catch (fileErr) {
            log.warn(
              `[SearchContent] replaceAll: failed to process ${file.file_path}:`,
              fileErr
            );
          }
        }
      } catch (err) {
        log.warn("[SearchContent] replaceAll: unexpected error:", err);
      } finally {
        setIsReplacingAll(false);
      }
    }, [query, replaceText, results, options, isReplacingAll]);

    const handleFilesToIncludeChange = useCallback(
      (value: string) => {
        setOptions({ filesToInclude: value });
      },
      [setOptions]
    );

    const handleFilesToExcludeChange = useCallback(
      (value: string) => {
        setOptions({ filesToExclude: value });
      },
      [setOptions]
    );

    const handleOnlyOpenFilesToggle = useCallback(() => {
      setOptions({ onlyOpenFiles: !options.onlyOpenFiles });
    }, [options.onlyOpenFiles, setOptions]);

    // Calculate shown counts from loaded results
    const shownMatches = results.reduce(
      (sum, file) => sum + file.matches.length,
      0
    );
    const shownFiles = results.length;

    // Determine if we should show the "refine search" suggestion
    const isLargeResultSet =
      actualTotalMatches >= SEARCH_CONSTANTS.WARNING_THRESHOLD;
    const showRefineHint = hasMore || isLargeResultSet;

    // Build result text - combines count and warning
    // Fix: Ensure displayed totals are never less than shown counts
    const displayTotalMatches = Math.max(shownMatches, actualTotalMatches);
    const displayTotalFiles = Math.max(shownFiles, actualTotalFiles);
    // Only show "X of Y" format when there are actually more results to load
    const showPartialCount = hasMore && shownMatches < displayTotalMatches;
    const totalMatchesText = isTruncated
      ? `${SEARCH_CONSTANTS.MAX_TOTAL_RESULTS.toLocaleString()}+`
      : displayTotalMatches.toLocaleString();

    const resultText = query
      ? loading
        ? t("status.searching")
        : loadingMore
          ? `${totalMatchesText} results in ${displayTotalFiles.toLocaleString()} files...`
          : showPartialCount
            ? `Top ${shownMatches.toLocaleString()} / ${totalMatchesText} in ${shownFiles.toLocaleString()} / ${displayTotalFiles.toLocaleString()} files`
            : `${totalMatchesText} results in ${displayTotalFiles.toLocaleString()} files`
      : "";

    return (
      <div className="flex h-full flex-col">
        {/* Search mode selector - shared component */}
        <div className="flex-shrink-0 px-3 pb-2">
          <SearchModeSelect
            value={searchMode}
            onChange={setSearchMode}
            size="small"
            surface="pane"
          />
        </div>

        {/* Search/Replace section with chevron layout */}
        <div className="flex gap-1.5 px-3">
          {/* Left column - Chevron toggle (centered vertically) */}
          <button
            onClick={handleExpandToggle}
            className="flex items-center justify-center self-center text-text-3"
            title={
              showReplace
                ? t(HUMANTOOLS_TEXT_KEYS.search.collapseReplace)
                : t(HUMANTOOLS_TEXT_KEYS.search.expandReplace)
            }
          >
            {showReplace ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={14}
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={14}
              />
            )}
          </button>

          {/* Center column - Input fields (stacked, left-aligned) */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-1.5">
            {/* Find input with inline options */}
            <SearchInput
              variant="sidebar"
              surface="pane"
              value={query}
              onChange={setQuery}
              placeholder={t("actions.find")}
              inputRef={searchInputRef}
              caseSensitive={options.caseSensitive}
              wholeWord={options.wholeWord}
              useRegex={options.useRegex}
              onCaseSensitiveToggle={handleCaseSensitiveToggle}
              onWholeWordToggle={handleWholeWordToggle}
              onRegexToggle={handleRegexToggle}
              multiline
              hideChevron
            />

            {/* Replace input */}
            {showReplace && (
              <ReplaceInput
                variant="sidebar"
                surface="pane"
                value={replaceText}
                onChange={setReplaceText}
                placeholder={t("actions.replace")}
                onReplaceAll={handleReplaceAll}
                disabled={
                  !query || loading || isReplacingAll || results.length === 0
                }
                multiline
                hideSpacer
              />
            )}
          </div>
        </div>

        {/* Search filters (conditional) */}
        {showFilters && (
          <SearchFilters
            filesToInclude={options.filesToInclude || ""}
            filesToExclude={options.filesToExclude || ""}
            onlyOpenFiles={options.onlyOpenFiles}
            onFilesToIncludeChange={handleFilesToIncludeChange}
            onFilesToExcludeChange={handleFilesToExcludeChange}
            onOnlyOpenFilesToggle={handleOnlyOpenFilesToggle}
          />
        )}

        {/* Results count + refine hint + open in editor */}
        {resultText && (
          <div className="flex-shrink-0 py-1.5 pl-3 pr-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[12px] text-text-3">{resultText}</p>
              {results.length > 0 && !loading && !loadingMore && (
                <button
                  onClick={handleOpenInTab}
                  className={HEADER_BUTTON.actionTreeRow}
                  title={t("tooltips.openInEditorTab")}
                >
                  <HugeiconsIcon
                    icon={SquareArrowUpRightIcon}
                    data-icon="arrow-up-right-from-square"
                    size={14}
                    strokeWidth={1.75}
                  />
                </button>
              )}
            </div>
            {showRefineHint && !loading && !loadingMore && (
              <p className="text-[12px] text-primary-6">
                {t("placeholders.refineQueryHint")}
              </p>
            )}
          </div>
        )}

        {/* Results list - virtualized for performance */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* No loading spinner — search is fast (<200ms). Error and no-results
              are delayed 2s via showFeedback to avoid flashing during brief loads. */}
          {error && showFeedback ? (
            <Placeholder
              variant="error"
              placement="sidebar"
              title={error}
              fillParentHeight
            />
          ) : results.length > 0 ? (
            <div className="flex h-full flex-col">
              {/* Virtualized search results */}
              <div className="min-h-0 flex-1">
                <SearchResults
                  ref={searchResultsRef}
                  results={results}
                  onMatchClick={onResultClick}
                  onEndReached={hasMore ? loadMore : undefined}
                  loadingMore={loadingMore}
                />
              </div>

              {/* Loading more indicator */}
              {hasMore && loadingMore && (
                <div className="flex-shrink-0 border-t border-border-2 px-4 py-2 text-center">
                  <p className="text-[12px] text-text-3">
                    {t("placeholders.loadingMore")}
                  </p>
                </div>
              )}

              {/* Truncation warning */}
              {isTruncated && !hasMore && (
                <div className="flex-shrink-0 border-t border-border-2 bg-fill-1 px-4 py-2">
                  <p className="text-[12px] text-text-3">
                    {t("placeholders.maxLimitReached")}
                  </p>
                </div>
              )}
            </div>
          ) : query.trim() && !loading && showFeedback ? (
            <Placeholder
              variant="no-results"
              title={t("common:common.noResults")}
              subtitle={t("placeholders.noResultsSubtitle")}
            />
          ) : !query.trim() && !loading ? (
            <div className="flex h-full flex-col justify-end px-3 pb-3">
              <Button
                variant="primary"
                size="small"
                className="w-full"
                onClick={handleOpenInTab}
              >
                {t("actions.openInTab")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
);

SearchContent.displayName = "SearchContent";

// Custom comparison for memo - only re-render when props that affect UI change
// Ignores callback props since they use refs internally
function arePropsEqual(
  prevProps: SearchContentProps,
  nextProps: SearchContentProps
): boolean {
  return (
    prevProps.repoPath === nextProps.repoPath &&
    prevProps.showFilters === nextProps.showFilters &&
    prevProps.openFiles?.length === nextProps.openFiles?.length &&
    prevProps.onOpenInTab === nextProps.onOpenInTab
    // onResultClick is intentionally ignored - should be stable via ref pattern
  );
}

// Memoized export
const MemoizedSearchContent = memo(SearchContent, arePropsEqual);
MemoizedSearchContent.displayName = "SearchContent";

export default MemoizedSearchContent;
