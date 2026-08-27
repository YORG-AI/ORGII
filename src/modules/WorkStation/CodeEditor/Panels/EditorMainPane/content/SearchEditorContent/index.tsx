/**
 * SearchEditorContent Component
 *
 * Full-tab search editor with browser URL-bar style search input.
 * Features:
 * - URL-bar style search input (centered, expands on focus)
 * - Mode selector
 * - Search options (case sensitive, whole word, regex)
 * - VS Code-style CodeMirror results with syntax highlighting
 * - Match decorations and click navigation
 * - File filters support
 *
 * This is the content rendered when a "search" tab is active in the editor.
 */
import { Filter } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { checkSemanticAvailable } from "@src/api/tauri/search";
import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";

import { SearchFilters } from "../../../shared";
import SearchBar from "./SearchBar";
import SearchEditorDocument from "./SearchEditorDocument";
import { serializeSearchResults } from "./serialization";
import type { SearchEditorContentProps, SearchMode } from "./types";
import { useSearchTabContent } from "./useSearchTabContent";

// ============================================
// Empty State
// ============================================

interface EmptyStateProps {
  query: string;
  loading: boolean;
}

const EmptyState: React.FC<EmptyStateProps> = memo(({ query, loading }) => {
  const { t } = useTranslation();

  if (loading) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        title={t("status.searching")}
        fillParentHeight
      />
    );
  }

  if (!query.trim()) {
    return null;
  }

  return (
    <Placeholder
      variant="no-results"
      placement="detail-panel"
      title={t("placeholders.noMatchingResults")}
      subtitle={t("placeholders.noResultsWithFilters")}
      fillParentHeight
    />
  );
});

EmptyState.displayName = "EmptyState";

// ============================================
// Main Component
// ============================================

export const SearchEditorContent: React.FC<SearchEditorContentProps> = memo(
  ({
    sessionScopeId,
    repoPath,
    initialQuery,
    initialOptions,
    onQueryChangeForTitle,
    onResultClick,
    openFiles = [],
  }) => {
    const { t } = useTranslation();

    // Search mode state
    const [searchMode, setSearchMode] = useState<SearchMode>("regex");
    const [advancedSearchAvailable, setAdvancedSearchAvailable] =
      useState(false);
    const [showFilters, setShowFilters] = useState(false);

    useEffect(() => {
      let cancelled = false;
      checkSemanticAvailable()
        .then((available) => {
          if (!cancelled) {
            setAdvancedSearchAvailable(available);
            if (!available) {
              setSearchMode("regex");
            }
          }
        })
        .catch(() => {
          if (!cancelled) {
            setAdvancedSearchAvailable(false);
            setSearchMode("regex");
          }
        });
      return () => {
        cancelled = true;
      };
    }, []);

    // Search hook - unified with sidebar search execution pipeline
    const { query, setQuery, options, setOptions, results, loading, error } =
      useSearchTabContent({
        repoPath,
        openFiles,
        searchMode,
        sessionScopeId,
        initialQuery,
        initialOptions,
      });

    // Option toggles
    const handleCaseSensitiveToggle = useCallback(() => {
      setOptions({ caseSensitive: !options.caseSensitive });
    }, [options.caseSensitive, setOptions]);

    const handleWholeWordToggle = useCallback(() => {
      setOptions({ wholeWord: !options.wholeWord });
    }, [options.wholeWord, setOptions]);

    const handleRegexToggle = useCallback(() => {
      setOptions({ useRegex: !options.useRegex });
    }, [options.useRegex, setOptions]);

    // Filter callbacks
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

    const handleToggleFilters = useCallback(() => {
      setShowFilters((prev) => !prev);
    }, []);

    useEffect(() => {
      if (!onQueryChangeForTitle) {
        return;
      }
      onQueryChangeForTitle(sessionScopeId, query);
    }, [sessionScopeId, query, onQueryChangeForTitle]);

    // Handle file path click (navigate to file)
    const handleFilePathClick = useCallback(
      (filePath: string, line: number) => {
        onResultClick(filePath, line);
      },
      [onResultClick]
    );

    // Serialize results for CodeMirror display
    const serializedResults = useMemo(() => {
      if (results.length === 0) return null;
      return serializeSearchResults(results, {
        query,
        mode: searchMode,
        caseSensitive: options.caseSensitive,
        wholeWord: options.wholeWord,
        useRegex: options.useRegex,
        repoPath,
      });
    }, [
      results,
      query,
      searchMode,
      options.caseSensitive,
      options.wholeWord,
      options.useRegex,
      repoPath,
    ]);

    return (
      <div className="flex h-full flex-col">
        {/* Search Bar */}
        <SearchBar
          query={query}
          onQueryChange={setQuery}
          mode={searchMode}
          onModeChange={setSearchMode}
          advancedAvailable={advancedSearchAvailable}
          isLoading={loading}
          caseSensitive={options.caseSensitive}
          wholeWord={options.wholeWord}
          useRegex={options.useRegex}
          onCaseSensitiveToggle={handleCaseSensitiveToggle}
          onWholeWordToggle={handleWholeWordToggle}
          onRegexToggle={handleRegexToggle}
          rightAction={
            <Button
              size="small"
              shape="square"
              iconOnly
              icon={
                <Filter
                  size={14}
                  className={showFilters ? "text-primary-6" : "text-text-3"}
                />
              }
              onClick={handleToggleFilters}
              title={t("tooltips.toggleFileFilters")}
              aria-label={t("tooltips.toggleFileFilters")}
            />
          }
        />

        {/* File Filters (collapsible) */}
        {showFilters && (
          <div className="shrink-0">
            <SearchFilters
              filesToInclude={options.filesToInclude || ""}
              filesToExclude={options.filesToExclude || ""}
              onlyOpenFiles={options.onlyOpenFiles}
              onFilesToIncludeChange={handleFilesToIncludeChange}
              onFilesToExcludeChange={handleFilesToExcludeChange}
              onOnlyOpenFilesToggle={handleOnlyOpenFilesToggle}
              sideBySideWhenWide={true}
              showBottomBorder={!query.trim()}
              alignWithTabSearchRow={true}
            />
          </div>
        )}

        {/* Results Content - VS Code-style CodeMirror display */}
        {/* Use same container structure as CodeViewerContent */}
        <div className="relative min-h-0 flex-1">
          {error ? (
            <Placeholder
              variant="error"
              placement="detail-panel"
              title={error}
              fillParentHeight
            />
          ) : serializedResults ? (
            <SearchEditorDocument
              content={serializedResults.text}
              matchRanges={serializedResults.matchRanges}
              filePathRanges={serializedResults.filePathRanges}
              onFilePathClick={handleFilePathClick}
              loading={loading}
              readOnly={false}
            />
          ) : (
            <EmptyState query={query} loading={loading} />
          )}
        </div>
      </div>
    );
  }
);

SearchEditorContent.displayName = "SearchEditorContent";

export default SearchEditorContent;
