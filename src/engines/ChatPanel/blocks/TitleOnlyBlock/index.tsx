/**
 * TitleOnlyBlock — header-only chat block.
 *
 * Renders icon + title (+ optional subtitle). No expandable body, no chevron,
 * no args/result preview. Use for tools whose entire useful information fits
 * in the (state-aware) title — e.g. `send_to_inbox`, where the title already
 * reads "Sent {{name}} to inbox" and the inbox itself is the permanent record.
 *
 * Routed via `ChatBlock::TitleOnly` in Rust + `TitleOnlyAdapter`. The adapter
 * resolves the running/done/failed label from the Rust registry (including
 * things like live countdown interpolation for `await_output(wait_for)`) and
 * passes the final string as `title`. This block is a dumb renderer.
 *
 * Optional `subtitle` renders via {@link EventBlockHeaderSubtitle} for a
 * second muted line (e.g. exit code, match status).
 */
import React from "react";

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

interface TitleOnlyBlockProps {
  /** Pre-translated header title (state-aware label from the Rust registry). */
  title: string;
  /** Header icon (resolved from the tool's `icon_id` by the adapter). */
  icon: React.ReactNode;
  /** Optional second line (muted). Shown whenever provided and non-empty. */
  subtitle?: React.ReactNode;
  /** Whether the underlying tool is still running (drives the stroke-draw shimmer). */
  isLoading?: boolean;
  /** When true, the icon renders muted to signal the call failed. */
  isFailed?: boolean;
  /** Optional event ID — wires header click to event-replay locate. */
  eventId?: string;
  toolUsage?: ToolUsageMetadata;
}

const TitleOnlyBlock: React.FC<TitleOnlyBlockProps> = React.memo(
  ({
    title,
    icon,
    subtitle,
    isLoading = false,
    isFailed = false,
    eventId,
    toolUsage,
  }) => {
    const {
      isHeaderHovered,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({ eventId });

    return (
      <div
        className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
      >
        <EventBlockHeader
          isCollapsed
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
            icon={icon}
            isCollapsed
            isHeaderHovered={isHeaderHovered}
            hasContent={false}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
            isFailed={isFailed}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {title}
          </EventBlockHeaderTitle>
          {subtitle != null && subtitle !== "" && (
            <EventBlockHeaderSubtitle isLoading={isLoading}>
              {subtitle}
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>
      </div>
    );
  }
);

TitleOnlyBlock.displayName = "TitleOnlyBlock";

export default TitleOnlyBlock;
