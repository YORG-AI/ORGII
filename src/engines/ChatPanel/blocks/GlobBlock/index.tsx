/**
 * Glob Block — header-only transparent variant for file pattern search.
 *
 * `find_files` / `glob_file_search` render as one header row. The matched file
 * list is visible in the simulator; chat shows the lifecycle title plus the
 * searched file pattern.
 */
import React from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
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

interface GlobBlockProps {
  /** Glob pattern */
  pattern: string;
  /** Whether currently loading */
  isLoading?: boolean;
  /** Optional event ID for simulator replay */
  eventId?: string;
  /**
   * Pre-translated header title for the current state. Adapter resolves via
   * `useLifecycleLabels("code_search", "find_files")` (or `"glob_file_search"`).
   */
  title: string;
  toolUsage?: ToolUsageMetadata;
}

const GlobBlock: React.FC<GlobBlockProps> = React.memo(
  ({ pattern, isLoading = false, eventId, title, toolUsage }) => {
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

    return (
      <div className={getEventBlockContainerClasses(false)}>
        <EventBlockHeader
          isCollapsed
          withHover={false}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={getToolIcon("glob_file_search", {
              size: 14,
              className: "text-text-2",
            })}
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
              <FileTypeIcon
                fileName={pattern}
                size="small"
                className="mr-1.5 shrink-0"
              />
              <span className="min-w-0 truncate">{pattern}</span>
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>
      </div>
    );
  }
);

GlobBlock.displayName = "GlobBlock";

export default GlobBlock;
