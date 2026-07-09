/**
 * AgentMessageBlock - Wraps agent messages in a collapsible block
 *
 * Header removed -- agent message content renders flush, with no row above
 * it. Agent messages still do NOT participate in "collapse all" so the user
 * can always read the conversation.
 *
 * **Clamping policy**: when the user is on the Agent Station surface
 * (`stationMode === "agent-station"`) AND the chat panel is NOT maximized,
 * the agent simulator is rendered alongside the chat and already shows the
 * full message. In that layout, we clamp the message in the chat panel to
 * a 20-line preview with the same expand-overlay pill that TerminalBlock
 * uses, so long replies don't push the user's eye away from the simulator.
 *
 * In every other layout (chat-panel maximized, or any non-agent-station
 * station mode) the full message renders as before. The clamp also no-ops
 * silently when content already fits inside the preview height — only
 * messages that genuinely overflow surface the fade + Show more pill.
 *
 * **Locate arrow**: while clamped, a footer-variant `EventNavigateIcon`
 * sits below the preview at the right edge so the user can jump to the
 * matching simulator surface in one click. Unlike the header variant it
 * is always visible (no hover gate) because there is no parent header row
 * to disclose it — the arrow IS the chrome.
 */
import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import ExpandOverlay from "@src/components/ExpandOverlay";

import { EventNavigateIcon } from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

// AgentMessageBlock renders flush in the chat panel — it has no container of
// its own — so the expand-overlay fade must dissolve into the chat-pane
// background (`bg-chat-pane`), not the inside-a-block `event-block-fade`
// color that other blocks use. Without this, the fade looks like a colored
// bar floating over the message.
const CHAT_PANE_FADE_FROM = "from-chat-pane";

// Ten lines at ~24px line-height. Earlier clamp keeps the chat-panel
// preview compact so the user's eye stays on the simulator side; the
// expand pill is the escape hatch when they want the full message.
const AGENT_MESSAGE_PREVIEW_MAX_HEIGHT = 240;

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
}

const AgentMessageBlock: React.FC<AgentMessageBlockProps> = ({
  children,
  eventId,
  rightContent,
  isStreaming = false,
}) => {
  const { t } = useTranslation("common");
  const clampEligible = useContext(AgentMessageClampContext);

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
      setOverflows(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [clampEligible, isExpanded]);

  if (!clampEligible) {
    return (
      <div className="w-full min-w-0 overflow-hidden px-2 py-0.5">
        {children}
        {rightContent && (
          <div className="mt-1 flex justify-end">{rightContent}</div>
        )}
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
    </div>
  );
};

AgentMessageBlock.displayName = "AgentMessageBlock";

export default AgentMessageBlock;
