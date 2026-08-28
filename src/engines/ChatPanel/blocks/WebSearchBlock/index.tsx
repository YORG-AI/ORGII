/**
 * WebSearch Block - Transparent variant for web search results
 *
 * Displays web search results as a structured list with link icons.
 * Same pattern as GlobBlock: EventBlockExpandableStackList + ComposerStackListRow.
 */
import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import { HugeiconsIcon, SquareArrowUpRightIcon } from "@src/icons";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  ComposerStackListRow,
  EVENT_LOADING_SHIMMER_TEXT_CLASSES,
  EventBlockExpandableStackList,
  EventBlockHeader,
  EventBlockHeaderIcon,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

const DEFAULT_VISIBLE_RESULTS = 5;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBlockProps {
  query: string;
  results: WebSearchResult[];
  isLoading?: boolean;
  defaultCollapsed?: boolean;
  eventId?: string;
  /**
   * Pre-translated header title. Adapter resolves via
   * `useLifecycleLabels("web_search")`.
   */
  title: string;
  toolUsage?: ToolUsageMetadata;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const WebSearchResultRow: React.FC<{ result: WebSearchResult }> = React.memo(
  ({ result }) => {
    const domain = extractDomain(result.url);
    const displayTitle = result.title || domain;

    return (
      <ComposerStackListRow
        title={result.snippet || result.url}
        leading={
          <HugeiconsIcon
            icon={SquareArrowUpRightIcon}
            data-icon="square-arrow-out-up-right"
            size={14}
            className="shrink-0 text-text-3"
          />
        }
        primary={displayTitle}
        secondary={domain}
      />
    );
  }
);
WebSearchResultRow.displayName = "WebSearchResultRow";

const renderResultRow = (
  result: WebSearchResult,
  _idx: number,
  _displayed: readonly WebSearchResult[]
) => <WebSearchResultRow result={result} />;

const getResultKey = (_result: WebSearchResult, idx: number) => String(idx);

const WebSearchBlock: React.FC<WebSearchBlockProps> = React.memo(
  ({
    query,
    results,
    isLoading = false,
    defaultCollapsed = true,
    eventId,
    title,
    toolUsage,
  }) => {
    const {
      isCollapsed: isExpanded,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({
      defaultCollapsed,
      eventId,
      collapseAllValue: false,
      preserveDefaultOnExpand: true,
    });

    const hasResults = results.length > 0;
    const toolIcon = getToolIcon("web_search", {
      size: 14,
      className: "text-text-2",
    });

    return (
      <div className={getEventBlockContainerClasses(false)}>
        <EventBlockHeader
          isCollapsed={!isExpanded}
          withHover={false}
          onClick={handleLocate}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          className={eventId ? "cursor-pointer" : undefined}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={toolIcon}
            isCollapsed={!isExpanded}
            isHeaderHovered={isHeaderHovered}
            onToggle={hasResults ? handleHeaderClick : undefined}
            hasContent={hasResults}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
          />
          <span
            className={`shrink-0 font-medium ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : "text-text-1"}`}
          >
            {title}
          </span>
          {query && (
            <span
              className={`min-w-0 flex-initial truncate ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : "text-text-1"}`}
              title={query}
            >
              {query}
            </span>
          )}
        </EventBlockHeader>

        {isExpanded && hasResults && !isLoading && (
          <EventBlockExpandableStackList
            layout="full"
            items={results}
            renderItem={renderResultRow}
            getKey={getResultKey}
            visibleCount={DEFAULT_VISIBLE_RESULTS}
          />
        )}
      </div>
    );
  }
);

WebSearchBlock.displayName = "WebSearchBlock";

export default WebSearchBlock;
