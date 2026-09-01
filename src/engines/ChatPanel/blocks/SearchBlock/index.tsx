/**
 * Search Block — header-only transparent variant for code search.
 *
 * Grep / symbol search results render as a single header row (icon + lifecycle
 * label + pattern). The result body is not
 * surfaced in chat — users inspect matches in the simulator.
 */
import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

interface SearchBlockProps {
  /** Search pattern/query */
  pattern: string;
  /** Whether currently loading */
  isLoading?: boolean;
  /** Optional event ID for simulator replay */
  eventId?: string;
  /** Optional action name for per-action icon (e.g. "grep", "find_files") */
  action?: string;
  /**
   * Pre-translated header title for the current state. Adapter resolves via
   * `useLifecycleLabels("code_search", action)` and picks running/done/failed.
   */
  title: string;
  toolUsage?: ToolUsageMetadata;
}

const SearchBlock: React.FC<SearchBlockProps> = React.memo(
  ({ pattern, isLoading = false, eventId, action, title, toolUsage }) => {
    const {
      isHeaderHovered,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({
      defaultCollapsed: true,
      eventId,
      collapseAllValue: false,
      preserveDefaultOnExpand: true,
    });

    const toolIcon = getToolIcon("code_search", {
      size: 14,
      className: "text-text-2",
      action,
    });

    return (
      <div className={getEventBlockContainerClasses(false)}>
        <EventBlockHeader
          isCollapsed
          withHover={false}
          onClick={handleLocate}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={toolIcon}
            isCollapsed
            isHeaderHovered={isHeaderHovered}
            hasContent={false}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {title}
          </EventBlockHeaderTitle>
          {pattern && (
            <EventBlockHeaderSubtitle
              isLoading={isLoading}
              title={pattern}
              className="text-text-1"
            >
              <span className="min-w-0 truncate">{pattern}</span>
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>
      </div>
    );
  }
);

SearchBlock.displayName = "SearchBlock";

export default SearchBlock;
