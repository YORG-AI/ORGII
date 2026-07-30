/**
 * SearchResultsCodeView Component
 *
 * Renders search results using lightweight DOM elements.
 * Each match is rendered as simple text spans with syntax highlighting via CSS.
 *
 * This approach is much more performant than using CodeMirror for each result,
 * as it avoids creating hundreds of heavy editor instances.
 *
 * Structure (following VS Code's searchResultsView.ts):
 * - File header (collapsible)
 *   - Match line: [lineNum] [before] [match] [after]
 */
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { getFileName } from "@src/util/file/pathUtils";

import type { SearchMatch, SearchResultFile } from "./types";

// ============================================
// Types
// ============================================

interface SearchResultsCodeViewProps {
  /** Search results to display */
  results: SearchResultFile[];
  /** Repository path for relative path display */
  repoPath: string;
  /** Callback when a match is clicked */
  onMatchClick: (filePath: string, line: number, column?: number) => void;
  /** Whether currently loading */
  loading?: boolean;
  /** Whether loading more results */
  loadingMore?: boolean;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get relative path from repo root
 */
function getRelativePath(filePath: string, repoPath: string): string {
  if (!filePath || !repoPath) return filePath;

  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRepo = repoPath.replace(/\\/g, "/");

  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length).replace(/^\//, "");
  }

  return filePath;
}

/**
 * Parse match text to extract before, match, and after portions
 * The match.text contains the full line, we need to highlight the matched portion
 */
function parseMatchText(match: SearchMatch): {
  before: string;
  matched: string;
  after: string;
} {
  const text = match.text;
  const column = match.column - 1; // 1-indexed to 0-indexed
  const endColumn = match.end_column - 1;

  // If column info is invalid, just return the whole text as matched
  if (column < 0 || endColumn <= column || column >= text.length) {
    return { before: "", matched: text, after: "" };
  }

  return {
    before: text.substring(0, column),
    matched: text.substring(column, endColumn),
    after: text.substring(endColumn),
  };
}

// ============================================
// Match Line Component
// ============================================

interface MatchLineProps {
  match: SearchMatch;
  filePath: string;
  onMatchClick: (filePath: string, line: number, column?: number) => void;
}

const MatchLine: React.FC<MatchLineProps> = memo(
  ({ match, filePath, onMatchClick }) => {
    const handleClick = useCallback(() => {
      onMatchClick(filePath, match.line, match.column);
    }, [filePath, match.line, match.column, onMatchClick]);

    const { before, matched, after } = useMemo(
      () => parseMatchText(match),
      [match]
    );

    // Show line range if multi-line match
    const lineDisplay =
      match.end_line > match.line
        ? `${match.line}-${match.end_line}`
        : `${match.line}`;

    return (
      <div
        className="group flex cursor-pointer items-center gap-2 py-0.5 pl-6 pr-3 hover:bg-fill-1"
        onClick={handleClick}
      >
        {/* Line number */}
        <span className="w-10 shrink-0 text-right text-[11px] text-text-4">
          {lineDisplay}
        </span>

        {/* Match text with highlighting */}
        <span className="min-w-0 flex-1 truncate text-[12px]">
          <span className="text-text-3">{before}</span>
          <span className="rounded-sm bg-warning-6/20 text-warning-6">
            {matched}
          </span>
          <span className="text-text-3">{after}</span>
        </span>
      </div>
    );
  }
);

MatchLine.displayName = "MatchLine";

// ============================================
// File Result Component
// ============================================

interface FileResultProps {
  result: SearchResultFile;
  repoPath: string;
  onMatchClick: (filePath: string, line: number, column?: number) => void;
  defaultExpanded?: boolean;
}

const FileResult: React.FC<FileResultProps> = memo(
  ({ result, repoPath, onMatchClick, defaultExpanded = true }) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);

    const relativePath = useMemo(
      () => getRelativePath(result.file_path, repoPath),
      [result.file_path, repoPath]
    );

    const fileName = useMemo(
      () => getFileName(result.file_path),
      [result.file_path]
    );

    const handleToggle = useCallback(() => {
      setIsExpanded((prev) => !prev);
    }, []);

    const handleFileClick = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        // Navigate to first match in file
        if (result.matches.length > 0) {
          const firstMatch = result.matches[0];
          onMatchClick(result.file_path, firstMatch.line, firstMatch.column);
        }
      },
      [result, onMatchClick]
    );

    return (
      <div className="border-b border-border-2">
        {/* File Header - 22px height like VS Code */}
        <div
          className="flex h-[22px] cursor-pointer items-center gap-1.5 px-2 hover:bg-fill-1"
          onClick={handleToggle}
        >
          <button
            type="button"
            className="flex shrink-0 items-center justify-center text-text-3"
          >
            {isExpanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
          </button>

          <FileTypeIcon fileName={fileName} size="small" />

          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-[12px] text-text-1 hover:underline"
            onClick={handleFileClick}
            title={relativePath}
          >
            {relativePath}
          </button>

          <span className="shrink-0 rounded bg-fill-2 px-1.5 py-0.5 text-[10px] text-text-3">
            {result.matches.length}
          </span>
        </div>

        {/* Matches - each 22px height */}
        {isExpanded && (
          <div className="flex flex-col">
            {result.matches.map((match, index) => (
              <MatchLine
                key={`${match.line}-${match.column}-${index}`}
                match={match}
                filePath={result.file_path}
                onMatchClick={onMatchClick}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
);

FileResult.displayName = "FileResult";

// ============================================
// Main Component
// ============================================

export const SearchResultsCodeView: React.FC<SearchResultsCodeViewProps> = memo(
  ({ results, repoPath, onMatchClick, loading, loadingMore }) => {
    const { t } = useTranslation();
    if (loading) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("placeholders.searching")}
          fillParentHeight
        />
      );
    }

    if (results.length === 0) {
      return null;
    }

    return (
      <div className="flex h-full flex-col overflow-auto">
        {results.map((result) => (
          <FileResult
            key={result.file_path}
            result={result}
            repoPath={repoPath}
            onMatchClick={onMatchClick}
          />
        ))}

        {loadingMore && (
          <div className="flex items-center justify-center py-3">
            <Loader2
              size={SPINNER_TOKENS.default}
              className="animate-spin text-text-3"
            />
          </div>
        )}
      </div>
    );
  }
);

SearchResultsCodeView.displayName = "SearchResultsCodeView";

export default SearchResultsCodeView;
