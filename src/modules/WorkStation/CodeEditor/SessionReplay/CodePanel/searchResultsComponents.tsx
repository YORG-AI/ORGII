/**
 * searchResultsComponents
 *
 * Shared UI sub-components for SearchResultsContent.
 * Extracted to keep the main component file under 600 lines.
 */
import React from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  COUNT_BADGE,
  getCountBadgeSizeClass,
} from "@src/config/workstation/tokens";
import {
  File01Icon,
  FolderOpenIcon,
  HugeiconsIcon,
  Search01Icon,
} from "@src/icons";
import BreadcrumbFileHeader from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";

import { getBasename, toRepoFirstDisplayPath } from "./pathUtils";
import { SEARCH_ROW_ICON_CLASS } from "./searchIcons";
import { isFolderLikePath, parseSearchKeywords } from "./searchResultsParsers";
import { type DiagnosticSeverity, getSeverityIcon } from "./severity";

// ============================================================================
// Primitive pills
// ============================================================================

export function HeaderPrimarySegment({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex w-fit max-w-none flex-none shrink-0 items-center gap-2 whitespace-nowrap text-primary-6">
      <span className="pointer-events-none inline-flex shrink-0 items-center justify-center leading-none [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:shrink-0">
        {icon}
      </span>
      <span className="text-[12px] font-medium leading-tight">{label}</span>
    </span>
  );
}

export function HeaderSeparator(): React.ReactElement {
  return <span className="mx-1 h-4 w-px flex-none shrink-0 bg-border-2" />;
}

export function CountPill({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <span className="inline-flex w-fit flex-none shrink-0 whitespace-nowrap rounded-full bg-fill-3 px-2 py-0.5 text-[12px] font-medium text-text-1">
      {children}
    </span>
  );
}

// ============================================================================
// Summary / header rows
// ============================================================================

export function ResultsSummaryLine({
  directory,
  countLabel,
}: {
  directory?: string;
  countLabel?: string;
}): React.ReactElement | null {
  if (!countLabel) return null;

  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-text-3">
      <span className="shrink-0 pl-1.5 font-medium tabular-nums text-text-1">
        {countLabel}
      </span>
      {directory ? (
        <>
          <span className="shrink-0 text-text-4">·</span>
          <span className="min-w-0 truncate" title={directory}>
            {directory}
          </span>
        </>
      ) : null}
    </div>
  );
}

export function SearchSummaryHeader({
  query,
  directory,
  countLabel,
  toolLabel,
}: {
  query: string;
  directory?: string;
  countLabel?: string;
  toolLabel: string;
}): React.ReactElement {
  const keywords = parseSearchKeywords(query);
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-2 px-3 py-2 ${countLabel ? "border-b border-border-2" : ""}`}
    >
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-border-2 bg-workstation-bg px-3 shadow-sm">
        <HeaderPrimarySegment
          icon={
            <HugeiconsIcon icon={Search01Icon} data-icon="search" size={14} />
          }
          label={toolLabel}
        />
        <HeaderSeparator />
        {keywords.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto scrollbar-hide">
            {keywords.map((keyword) => (
              <span
                key={keyword}
                className="w-fit flex-none shrink-0 whitespace-nowrap rounded-full bg-fill-3 px-2 py-0.5 text-[12px] font-medium text-text-1"
              >
                {keyword}
              </span>
            ))}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-3">
            Search
          </span>
        )}
      </div>
      <ResultsSummaryLine directory={directory} countLabel={countLabel} />
    </div>
  );
}

export function DirectorySummaryHeader({
  directory,
  countLabel,
}: {
  directory?: string;
  countLabel?: string;
}): React.ReactElement {
  const displayDirectory = directory || "/";
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-2 px-3 py-2 ${countLabel ? "border-b border-border-2" : ""}`}
    >
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-border-2 bg-workstation-bg px-3 shadow-sm">
        <HeaderPrimarySegment
          icon={
            <HugeiconsIcon
              icon={FolderOpenIcon}
              data-icon="folder-open"
              size={14}
            />
          }
          label="List directory"
        />
        <HeaderSeparator />
        <BreadcrumbFileHeader
          filePath={displayDirectory}
          disableNavigation
          lastSegmentIcon={null}
          textSizeClassName="text-[12px]"
        />
      </div>
      <ResultsSummaryLine directory={directory} countLabel={countLabel} />
    </div>
  );
}

export function LspSummaryHeader({
  filePath,
  directory,
  countLabel,
  fileCountLabel,
}: {
  filePath?: string;
  directory?: string;
  countLabel?: string;
  fileCountLabel?: string;
}): React.ReactElement {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 border-b border-border-2 px-3 py-2">
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-border-2 bg-workstation-bg px-3 shadow-sm">
        <HeaderPrimarySegment
          icon={<HugeiconsIcon icon={File01Icon} data-icon="file" size={14} />}
          label="LSP"
        />
        <HeaderSeparator />
        {filePath ? (
          <BreadcrumbFileHeader
            filePath={filePath}
            disableNavigation
            lastSegmentIcon={null}
            textSizeClassName="text-[12px]"
          />
        ) : null}
        {fileCountLabel ? <CountPill>{fileCountLabel}</CountPill> : null}
      </div>
      <ResultsSummaryLine directory={directory} countLabel={countLabel} />
    </div>
  );
}

// ============================================================================
// Row components
// ============================================================================

export function DiagnosticRow({
  severity,
  message,
  source,
  line,
}: {
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
  line: number;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded px-2 py-1 hover:bg-fill-2">
      <span className="shrink-0">{getSeverityIcon(severity)}</span>
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-text-1"
        title={message}
      >
        {message}
      </span>
      {source ? (
        <span className="shrink-0 text-[11px] text-text-4">{source}</span>
      ) : null}
      {line > 0 ? (
        <span className="shrink-0 text-[11px] tabular-nums text-text-4">
          [Ln {line}]
        </span>
      ) : null}
    </div>
  );
}

function renderHighlightedSearchText(
  text: string,
  highlightTerms: string[]
): React.ReactNode {
  const normalizedTerms = Array.from(
    new Set(
      highlightTerms
        .map((term) => term.trim())
        .filter(Boolean)
        .sort((firstTerm, secondTerm) => secondTerm.length - firstTerm.length)
    )
  );

  if (normalizedTerms.length === 0) return text;

  const lowerText = text.toLowerCase();
  const lowerTerms = normalizedTerms.map((term) => term.toLowerCase());
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextMatchIndex = -1;
    let nextMatchLength = 0;

    for (const term of lowerTerms) {
      const candidateIndex = lowerText.indexOf(term, cursor);
      if (candidateIndex === -1) continue;
      if (
        nextMatchIndex === -1 ||
        candidateIndex < nextMatchIndex ||
        (candidateIndex === nextMatchIndex && term.length > nextMatchLength)
      ) {
        nextMatchIndex = candidateIndex;
        nextMatchLength = term.length;
      }
    }

    if (nextMatchIndex === -1) {
      parts.push(text.slice(cursor));
      break;
    }

    if (nextMatchIndex > cursor) {
      parts.push(text.slice(cursor, nextMatchIndex));
    }

    const matchedText = text.slice(
      nextMatchIndex,
      nextMatchIndex + nextMatchLength
    );
    parts.push(
      <span key={`${nextMatchIndex}-${matchedText}`} className="text-primary-6">
        {matchedText}
      </span>
    );
    cursor = nextMatchIndex + nextMatchLength;
  }

  return parts;
}

export function SearchMatchRow({
  message,
  lineLabel,
  highlightTerms,
}: {
  message: string;
  lineLabel?: string;
  highlightTerms?: string[];
}): React.ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded px-2 py-1 hover:bg-fill-2">
      <span
        className="min-w-0 flex-1 truncate text-[12px] text-text-1"
        title={message}
      >
        {renderHighlightedSearchText(message, highlightTerms ?? [])}
      </span>
      {lineLabel ? (
        <span className="shrink-0 text-[11px] tabular-nums text-text-4">
          {lineLabel}
        </span>
      ) : null}
    </div>
  );
}

export function ExploreResultRow({
  filePath,
  workspaceDirectoryHint,
  detail,
  count,
  lineLabel,
}: {
  filePath: string;
  workspaceDirectoryHint?: string;
  detail?: string;
  count?: number;
  lineLabel?: string;
}): React.ReactElement {
  const displayPath = toRepoFirstDisplayPath(filePath, workspaceDirectoryHint);
  const baseName = getBasename(filePath);
  const isFolder = isFolderLikePath(filePath);

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-0.5 rounded px-2 py-1.5 hover:bg-fill-2">
      <div className="flex min-w-0 items-center gap-2">
        <FileTypeIcon
          fileName={baseName || filePath}
          type={isFolder ? "folder" : undefined}
          size="small"
          className={SEARCH_ROW_ICON_CLASS}
        />
        <span className="shrink-0 truncate text-[13px] font-semibold text-text-1">
          {baseName || filePath}
        </span>
        {displayPath ? (
          <span
            className="min-w-0 flex-1 truncate text-[12px] text-text-3"
            title={displayPath}
          >
            {displayPath}
          </span>
        ) : null}
        {typeof count === "number" && count > 0 ? (
          <span
            className={`ml-auto ${COUNT_BADGE.base} ${getCountBadgeSizeClass(count)} ${COUNT_BADGE.primary} tabular-nums`}
          >
            {count}
          </span>
        ) : null}
      </div>
      {detail || lineLabel ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-6">
          {detail ? (
            <span className="min-w-0 truncate text-[12px] text-text-2">
              {detail}
            </span>
          ) : null}
          {lineLabel ? (
            <span className="shrink-0 text-[11px] tabular-nums text-text-4">
              {lineLabel}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface GroupedExploreResult<T> {
  filePath: string;
  items: T[];
}

export function GroupedExploreResultRows<T>({
  groups,
  workspaceDirectoryHint,
  getCount,
  renderItem,
}: {
  groups: GroupedExploreResult<T>[];
  workspaceDirectoryHint?: string;
  getCount?: (group: GroupedExploreResult<T>) => number;
  renderItem: (item: T, itemIndex: number, filePath: string) => React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex w-full min-w-0 flex-col p-2">
      {groups.map((group, groupIndex) => (
        <div
          key={`${group.filePath}-${groupIndex}`}
          className="flex w-full min-w-0 flex-col"
        >
          <ExploreResultRow
            filePath={group.filePath}
            workspaceDirectoryHint={workspaceDirectoryHint}
            count={getCount ? getCount(group) : group.items.length}
          />
          <div className="flex w-full min-w-0 flex-col pl-6">
            {group.items.map((item, itemIndex) =>
              renderItem(item, itemIndex, group.filePath)
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
