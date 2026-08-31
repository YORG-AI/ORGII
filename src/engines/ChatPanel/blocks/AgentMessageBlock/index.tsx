/**
 * AgentMessageBlock - Wraps agent messages in a collapsible block
 *
 * Header removed -- agent message content renders flush, with no row above
 * it. Agent messages still do NOT participate in "collapse all" so the user
 * can always read the conversation.
 *
 * **Clamping policy**: completed agent messages clamp long content to a
 * 20-line preview with the same expand-overlay pill that TerminalBlock uses.
 * This applies to every round, the latest included; only the live streaming
 * message stays fully open so active generation remains readable.
 *
 * The clamp no-ops silently when content already fits inside the preview
 * height — only messages that genuinely overflow surface the fade + Show
 * more pill. Renderers outside a turn context retain the host-provided clamp
 * eligibility for synthetic previews.
 *
 * **Locate arrow**: while clamped, a footer-variant `EventNavigateIcon`
 * sits below the preview at the right edge so the user can jump to the
 * matching simulator surface in one click. Unlike the header variant it
 * is always visible (no hover gate) because there is no parent header row
 * to disclose it — the arrow IS the chrome.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import ExpandOverlay from "@src/components/ExpandOverlay";
import MessageFooter from "@src/components/MessageFooter";
import { useAgentTurnContext } from "@src/engines/ChatPanel/ChatHistory/AgentTurnContext";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { EventNavigateIcon } from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

// AgentMessageBlock renders flush in the chat panel — it has no container of
// its own — so the expand-overlay fade must dissolve into the chat-pane
// background (`bg-chat-pane`), not the inside-a-block `event-block-fade`
// color that other blocks use. Without this, the fade looks like a colored
// bar floating over the message.
const CHAT_PANE_FADE_FROM = "from-chat-pane";

// Twenty lines at ~24px line-height, matching the earlier long-message
// preview depth used by the chat pane.
export const AGENT_MESSAGE_PREVIEW_MAX_HEIGHT = 480;

export function resolveAgentMessageClampEligibility(
  isLastGroup: boolean | null,
  fallbackEligible: boolean
): boolean {
  // Every round inside a turn context clamps long (>20-line) messages — the
  // latest round included. The live streaming tail is exempted separately by
  // the caller (via `isStreaming`) so active generation stays fully visible.
  // Outside a turn context (synthetic previews) fall back to the host flag.
  return isLastGroup === null ? fallbackEligible : true;
}

export function shouldShowAgentMessageFooter(params: {
  content: string | undefined;
  isStreaming: boolean;
  itemIndex: number | undefined;
  lastAssistantFlatIndex: number | null | undefined;
}): boolean {
  return Boolean(
    !params.isStreaming &&
    params.content?.trim() &&
    params.itemIndex !== undefined &&
    params.itemIndex === params.lastAssistantFlatIndex
  );
}

const AgentMessageClampContext = createContext(false);

export const AgentMessageClampProvider = AgentMessageClampContext.Provider;

export interface AgentMessageBlockProps {
  children: React.ReactNode;
  /**
   * Event id used by the locate arrow to jump to the matching simulator
   * event. Omitted for synthetic preview rendering where no event exists.
   */
  eventId?: string;
  rightContent?: React.ReactNode;
  /** Hide footer chrome while tokens are still streaming. */
  isStreaming?: boolean;
  /** Visible content used to qualify the final-message footer. */
  messageContent?: string;
  /** Event timestamp displayed by the final-message footer. */
  messageTimestamp?: string;
  /** Flat chat-history index used to identify the round's final message. */
  itemIndex?: number;
}

const AgentMessageBlock: React.FC<AgentMessageBlockProps> = ({
  children,
  eventId,
  rightContent,
  isStreaming = false,
  messageContent,
  messageTimestamp = "",
  itemIndex,
}) => {
  const { t, i18n } = useTranslation(["common", "sessions"]);
  const fallbackClampEligible = useContext(AgentMessageClampContext);
  const turnContext = useAgentTurnContext();
  const showMessageFooter = shouldShowAgentMessageFooter({
    content: messageContent,
    isStreaming,
    itemIndex,
    lastAssistantFlatIndex: turnContext?.lastAssistantFlatIndex,
  });
  const timestampLabel =
    showMessageFooter && messageTimestamp
      ? formatSmartDateTime(messageTimestamp, {
          yesterdayLabel: t("relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.resolvedLanguage),
        })
      : "";
  const getTurnCopyContent = useCallback(
    () =>
      turnContext?.resolveAssistantTurnCopyContent(
        turnContext.assistantCopyEventIds
      ) ?? "",
    [turnContext]
  );
  const getCopyContent =
    turnContext && turnContext.assistantCopyEventIds.length > 0
      ? getTurnCopyContent
      : undefined;
  const messageFooter = showMessageFooter ? (
    <MessageFooter
      getCopyContent={getCopyContent}
      timestamp={messageTimestamp}
      timestampLabel={timestampLabel}
      copyLabel={t("sessions:chat.copyTurn")}
      copiedLabel={t("status.copied")}
      copyFailedLabel={t("errors.failedToCopy")}
      className="mt-1"
    />
  ) : null;
  // The live streaming message is never clamped — it grows as tokens arrive
  // and hiding the tail behind a preview would bury the newest output. Once
  // it settles (isStreaming false) it clamps like any other completed message,
  // including in the latest round.
  const clampEligible =
    !isStreaming &&
    resolveAgentMessageClampEligibility(
      turnContext?.isLastGroup ?? null,
      fallbackClampEligible
    );

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Reset clamp-derived state during render whenever clampEligibility flips,
  // following React's "adjusting state during rendering" pattern. Doing this
  // here (rather than in an effect) avoids a cascading render and keeps the
  // first render after a layout change consistent — re-entering the docked
  // layout always starts collapsed with no stale overflow signal.
  const [prevClampEligible, setPrevClampEligible] = useState(clampEligible);
  if (prevClampEligible !== clampEligible) {
    setPrevClampEligible(clampEligible);
    if (isExpanded) setIsExpanded(false);
    if (overflows) setOverflows(false);
  }

  // Reuse the shared header hook purely for its replay-locate wiring. We
  // don't render a header row here — `handleLocate` is the only piece we
  // need. Without an `eventId` it degrades to a no-op, which matches what
  // the EventNavigateIcon would do anyway.
  const { handleLocate } = useBlockHeader({
    eventId,
    defaultCollapsed: false,
    collapseAllValue: false,
  });

  // Measure overflow whenever clampability or expansion state changes.
  // Also observe the viewport for content reflow (markdown re-renders while
  // streaming, image loads, etc.) so the pill appears as soon as content
  // pushes past the preview height. Skip entirely when clamping is not
  // eligible — there's no measurement we'd act on.
  useLayoutEffect(() => {
    if (!clampEligible) return;
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      // Compare content height against the fixed preview height, NOT against
      // clientHeight. clientHeight is subject to sub-pixel line-height
      // rounding that reads 1–2px larger than scrollHeight for single-line
      // content — and once the overlay mounts inside this measured element it
      // latches — which false-positived the clamp on one-line messages
      // (wrapping the same text to two lines made the discrepancy vanish).
      // The clamp only needs to fire when content genuinely exceeds the
      // 20-line preview, so measure that directly.
      setOverflows(element.scrollHeight > AGENT_MESSAGE_PREVIEW_MAX_HEIGHT + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clampEligible, isExpanded]);

  if (!clampEligible) {
    return (
      <div className="group/agent-message w-full min-w-0 overflow-hidden px-2 py-0.5">
        {children}
        {rightContent && (
          <div className="mt-1 flex justify-end">{rightContent}</div>
        )}
        {messageFooter}
      </div>
    );
  }

  const showOverlay = overflows || isExpanded;
  // Locate arrow shows for settled clamped messages with an event id. Hide it
  // while streaming so the footer chrome does not trail the growing text.
  const showLocateArrow = Boolean(eventId) && !isStreaming;
  return (
    <div
      className={`group/agent-message w-full min-w-0 px-2 py-0.5 ${isExpanded ? "overflow-visible" : "overflow-hidden"}`}
    >
      <div
        ref={viewportRef}
        className="group/expand relative scrollbar-hide"
        style={
          isExpanded
            ? { maxHeight: "none", overflow: "visible" }
            : {
                maxHeight: AGENT_MESSAGE_PREVIEW_MAX_HEIGHT,
                overflow: "hidden",
              }
        }
      >
        {children}
        {showOverlay && (
          <ExpandOverlay
            isExpanded={isExpanded}
            onToggle={(event) => {
              event.stopPropagation();
              setIsExpanded((prev) => !prev);
            }}
            collapsedLabel={t("actions.expand")}
            expandedLabel={t("actions.collapse")}
            fadeFrom={CHAT_PANE_FADE_FROM}
            showLabel
            alwaysShowControl
          />
        )}
      </div>
      {rightContent && (
        <div className="mt-1 flex justify-end">{rightContent}</div>
      )}
      {showLocateArrow && (
        <div className="mt-1 flex justify-end">
          <EventNavigateIcon
            onClick={handleLocate ?? (() => undefined)}
            variant="footer-hover"
          />
        </div>
      )}
      {messageFooter}
    </div>
  );
};

AgentMessageBlock.displayName = "AgentMessageBlock";

export default AgentMessageBlock;
