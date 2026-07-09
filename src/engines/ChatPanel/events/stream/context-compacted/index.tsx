/**
 * ContextCompactedEvent — Collapsed compact-boundary marker.
 *
 * Rendered via the event registry under `context_compacted` for persisted
 * compact-boundary rows (see `persistedMessageToSessionEvent` in
 * SessionCore/ingestion/agentMessageAdapters.ts). Shows a collapsed-by-default
 * block titled "Context compacted" with the cleaned conversation summary in
 * the expanded body; the model-facing continuation instructions are stripped
 * at ingestion.
 *
 * Boundary rows only arrive via the history reload path (never live events),
 * so this component renders the same block for every variant — mirroring
 * RateLimitHintEvent rather than ThinkingEvent's chat/simulator split.
 */
import { Archive } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { formatTokenCount } from "@src/engines/ChatPanel/InputArea/components/useContextUsageInfo";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
  getEventBlockContentClasses,
  useEventBlockHeader,
} from "@src/engines/ChatPanel/blocks/primitives";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";

export interface ContextCompactedEventProps extends RawEventInput {
  /** Force a specific variant (auto-detected if not provided) */
  variant?: EventVariant;
}

export const ContextCompactedEvent: React.FC<ContextCompactedEventProps> = (
  props
) => {
  const { t } = useTranslation();
  const normalizedProps = useNormalizedEventProps(props, "context_compacted");
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useEventBlockHeader({
    defaultCollapsed: true,
    collapseAllValue: true,
  });

  if (!normalizedProps) return null;

  const result = normalizedProps.result ?? {};
  const summary =
    typeof result.observation === "string" ? result.observation : "";
  const compactedCount =
    typeof result.compactedCount === "number" ? result.compactedCount : null;
  const tokensBefore =
    typeof result.tokensBefore === "number" ? result.tokensBefore : null;
  const tokensAfter =
    typeof result.tokensAfter === "number" ? result.tokensAfter : null;
  const hasContent = Boolean(summary.trim());

  const icon = (
    <Archive size={SESSION_UI_TOKENS.ICON.SIZE_SM} className="text-text-3" />
  );

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={hasContent ? handleHeaderClick : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={icon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={handleHeaderClick}
          hasContent={hasContent}
        />
        <EventBlockHeaderTitle>
          {t("contextInfo.compactBoundaryTitle")}
        </EventBlockHeaderTitle>
        {compactedCount !== null && (
          <span className="min-w-0 truncate leading-tight text-text-3">
            {t("contextInfo.compactBoundarySubtitle", {
              count: compactedCount,
            })}
          </span>
        )}
        {tokensBefore !== null && tokensAfter !== null && (
          <span className="min-w-0 shrink-0 truncate leading-tight text-text-3">
            {t("contextInfo.compactBoundaryTokens", {
              before: formatTokenCount(tokensBefore),
              after: formatTokenCount(tokensAfter),
            })}
          </span>
        )}
      </EventBlockHeader>

      {!isCollapsed && hasContent && (
        <div className="ml-[14px] border-l border-border-1 py-0.5">
          <div
            className={`pl-3 ${getEventBlockContentClasses({ padding: "p-0" })}`}
          >
            <div className="allow-select">
              <Markdown textContent={summary} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

ContextCompactedEvent.displayName = "ContextCompactedEvent";

export default ContextCompactedEvent;
