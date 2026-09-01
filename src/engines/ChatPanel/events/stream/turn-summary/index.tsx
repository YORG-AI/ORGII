/**
 * TurnSummaryEvent - Chat rendering for agent:turn_summary events.
 *
 * Displays a collapsible summary card at the end of each agent turn,
 * showing: summary text (markdown), tool call count, and wall time.
 *
 * Chat variant: collapsed by default — a subtle footer row.
 * Simulator variant: header + full summary body, expanded by default.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useBlockHeader } from "@src/engines/ChatPanel/blocks/useBlockLocate";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";
import { HugeiconsIcon, Layers01Icon } from "@src/icons";

// ============================================
// Types
// ============================================

interface TurnSummaryEventProps extends RawEventInput {
  variant?: EventVariant;
}

interface SummaryData {
  summaryText: string;
  toolCalls?: number;
  wallTimeSecs?: number;
}

// ============================================
// Data extraction
// ============================================

function extractSummaryData(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): SummaryData {
  const summaryText =
    (result.observation as string) ||
    (result.content as string) ||
    (result.summary as string) ||
    "";

  const toolCalls =
    typeof args.toolCalls === "number" ? args.toolCalls : undefined;
  const wallTimeSecs =
    typeof args.wallTimeSecs === "number" ? args.wallTimeSecs : undefined;

  return { summaryText, toolCalls, wallTimeSecs };
}

// ============================================
// Meta helpers — tool count + elapsed time join
// ============================================

function formatWallTime(wallTimeSecs: number): string {
  if (wallTimeSecs >= 60) {
    return `${Math.floor(wallTimeSecs / 60)}m ${wallTimeSecs % 60}s`;
  }
  return `${wallTimeSecs}s`;
}

function useMetaSubtitle(
  toolCalls: number | undefined,
  wallTimeSecs: number | undefined
): string | null {
  const { t } = useTranslation("sessions");
  const parts: string[] = [];
  if (toolCalls !== undefined) {
    parts.push(t("tools.turnSummary.toolCallsCount", { count: toolCalls }));
  }
  if (wallTimeSecs !== undefined) {
    parts.push(formatWallTime(wallTimeSecs));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ============================================
// Chat Variant — collapsed by default
// ============================================

const ChatCard: React.FC<SummaryData & { eventId?: string }> = ({
  summaryText,
  toolCalls,
  wallTimeSecs,
  eventId,
}) => {
  const { t } = useTranslation("sessions");
  const hasBody = Boolean(summaryText);
  const metaSubtitle = useMetaSubtitle(toolCalls, wallTimeSecs);

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: true,
    eventId,
    collapseAllValue: true,
  });

  const icon = (
    <HugeiconsIcon
      icon={Layers01Icon}
      data-icon="layers"
      size={SESSION_UI_TOKENS.ICON.SIZE_SM}
      className={SESSION_UI_TOKENS.ICON.DEFAULT}
    />
  );

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={icon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={hasBody ? handleHeaderClick : undefined}
          hasContent={hasBody}
        />
        <EventBlockHeaderTitle>
          {t("tools.turnSummary.label")}
        </EventBlockHeaderTitle>
        {metaSubtitle && (
          <EventBlockHeaderSubtitle title={metaSubtitle}>
            {metaSubtitle}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {hasBody && !isCollapsed && (
        <div
          className={getEventBlockContentClasses({ padding: "px-3 pt-1 pb-3" })}
        >
          <div className="chat-block-content leading-relaxed text-text-2">
            <Markdown textContent={summaryText} />
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================
// Simulator Variant — expanded by default
// ============================================

const SimulatorCard: React.FC<SummaryData & { eventId?: string }> = ({
  summaryText,
  toolCalls,
  wallTimeSecs,
  eventId,
}) => {
  const { t } = useTranslation("sessions");
  const metaSubtitle = useMetaSubtitle(toolCalls, wallTimeSecs);

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: false,
    eventId,
    collapseAllValue: false,
  });

  const icon = (
    <HugeiconsIcon
      icon={Layers01Icon}
      data-icon="layers"
      size={SESSION_UI_TOKENS.ICON.SIZE_SM}
      className={SESSION_UI_TOKENS.ICON.DEFAULT}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <HugeiconsIcon
          icon={Layers01Icon}
          data-icon="layers"
          size={SESSION_UI_TOKENS.ICON.SIZE_MD}
          className={SESSION_UI_TOKENS.ICON.DEFAULT}
        />
        <span className={SESSION_UI_TOKENS.TEXT.TITLE_BASE}>
          {t("tools.turnSummary.label")}
        </span>
        {metaSubtitle && (
          <span className="min-w-0 flex-1 truncate text-text-2">
            {metaSubtitle}
          </span>
        )}
      </div>

      {summaryText && (
        <div className={getEventBlockContainerClasses(true)}>
          <EventBlockHeader
            isCollapsed={isCollapsed}
            withHover={false}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
          >
            <EventBlockHeaderIcon
              icon={icon}
              isCollapsed={isCollapsed}
              isHeaderHovered={isHeaderHovered}
              onToggle={handleHeaderClick}
              hasContent
            />
            <span className={SESSION_UI_TOKENS.TEXT.LABEL_XS}>
              {t("tools.turnSummary.outputLabel")}
            </span>
          </EventBlockHeader>

          {!isCollapsed && (
            <div className={getEventBlockContentClasses({ padding: "p-3" })}>
              <div className={SESSION_UI_TOKENS.TEXT.BODY_SM}>
                <Markdown textContent={summaryText} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ============================================
// Main Component
// ============================================

export const TurnSummaryEvent: React.FC<TurnSummaryEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "turn_summary");

  if (!normalizedProps) return null;

  const data = extractSummaryData(
    normalizedProps.args ?? {},
    normalizedProps.result ?? {}
  );
  const eventId = normalizedProps.eventId;

  if (normalizedProps.variant === "chat") {
    return <ChatCard {...data} eventId={eventId} />;
  }

  return <SimulatorCard {...data} eventId={eventId} />;
};

TurnSummaryEvent.displayName = "TurnSummaryEvent";

export default TurnSummaryEvent;
