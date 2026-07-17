/**
 * Extended Item Renderers
 *
 * Renderers for grouped/optimized chat item types:
 * - readFileGroup
 * - activityStackGroup, threadSelector
 *
 * Extracted from ChatItemRenderer for modularity.
 */
import i18next from "i18next";
import { useAtomValue } from "jotai";
import { AlertCircle, Chrome, FileSymlink, Globe } from "lucide-react";
import React from "react";

import ToolCallBlock from "@src/engines/ChatPanel/blocks/ToolCallBlock";
import {
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  StackedBlock,
} from "@src/engines/ChatPanel/blocks/primitives";
import { streamingDeltaContentAtom } from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";

import ActionSummaryGroup from "../../ChatItems/ActionSummaryGroup";
import EditActivityGroup from "../../ChatItems/EditActivityGroup";
import ReadFileGroup from "../../ChatItems/ReadFileGroup";
import TerminalActivityGroup from "../../ChatItems/TerminalActivityGroup";
import ActivityChatItem from "../ActivityRouter";
import type { OptimizedChatItem } from "../chatItemPipeline";
import ChatItemWrap from "./ChatItemWrap";
import {
  MemoizedThreadSelector,
  type ThreadSelectorChatItem,
} from "./MemoizedItems";

const log = createLogger("ChatItemRenderer");

function isSyntheticLiveActivity(event: SessionEvent): boolean {
  return event.args?.syntheticLive === true;
}

const ActivityRow: React.FC<{
  event: SessionEvent;
  index: number;
  itemKey: string;
  totalOccurrences?: number;
}> = ({ event, index, itemKey, totalOccurrences }) => {
  const sessionId = useAtomValue(sessionIdAtom);
  const streamingMap = useAtomValue(streamingDeltaContentAtom);
  const liveDelta = sessionId ? streamingMap.get(sessionId) : undefined;
  const streamingContent =
    liveDelta?.kind === "message" ? liveDelta.content : undefined;

  if (isSyntheticLiveActivity(event) && !streamingContent?.trim()) {
    return null;
  }

  const isTextActivity = event.actionType === "assistant";

  return (
    <ChatItemWrap
      key={itemKey}
      variant={isTextActivity ? "text" : "default"}
      className="chat-item-wrap--activity"
    >
      <ActivityChatItem
        event={event}
        status={event.activityStatus || "agent"}
        itemIndex={index}
        isStreaming={event.isDelta === true}
      />
      {totalOccurrences !== undefined && totalOccurrences >= 2 && (
        <div className={SESSION_UI_TOKENS.ROW.INLINE}>
          <EventBlockHeaderIcon
            icon={
              <AlertCircle
                size={SESSION_UI_TOKENS.ICON.SIZE_SM}
                className="text-warning-6"
              />
            }
            hasContent={false}
          />
          <EventBlockHeaderTitle className="text-warning-6">
            {i18next.t("sessions:tools.repeatedErrorNotice", {
              count: totalOccurrences,
            })}
          </EventBlockHeaderTitle>
        </div>
      )}
    </ChatItemWrap>
  );
};

// ============================================
// Renderer Functions
// ============================================

export function renderActivity(
  chatItem: OptimizedChatItem,
  index: number,
  itemKey: string
): React.ReactElement | null {
  const event = chatItem.event;
  if (!event && process.env.NODE_ENV === "development") {
    log.warn("[ChatItemRenderer] activity item missing event:", chatItem);
  }
  if (!event) return null;

  // repeatedErrorCount stores extra occurrences beyond the first, so total = count + 1.
  const extraRepeats = chatItem.repeatedErrorCount;
  const totalOccurrences =
    extraRepeats !== undefined ? extraRepeats + 1 : undefined;

  return (
    <ActivityRow
      key={itemKey}
      event={event}
      index={index}
      itemKey={itemKey}
      totalOccurrences={totalOccurrences}
    />
  );
}

export function renderReadFileGroup(
  chatItem: OptimizedChatItem,
  itemKey: string
): React.ReactElement | null {
  if (!chatItem.readFileEvents || chatItem.readFileEvents.length === 0) {
    return null;
  }
  return (
    <ChatItemWrap key={itemKey}>
      <ReadFileGroup events={chatItem.readFileEvents} />
    </ChatItemWrap>
  );
}

export function renderActionSummaryGroup(
  chatItem: OptimizedChatItem,
  itemKey: string
): React.ReactElement | null {
  if (
    !chatItem.actionSummaryEntries ||
    chatItem.actionSummaryEntries.length === 0
  ) {
    return null;
  }
  return (
    <ChatItemWrap key={itemKey}>
      <ActionSummaryGroup
        entries={chatItem.actionSummaryEntries}
        items={chatItem.actionSummaryItems}
        closedByBoundary={chatItem.actionSummaryClosedByBoundary}
      />
    </ChatItemWrap>
  );
}

function getStackGroupPresentation(events: SessionEvent[]): {
  icon: React.ReactNode;
  label: string;
} {
  // Prefer uiCanonical (pre-computed, alias-resolved) over the raw functionName
  // so that matching is stable even when the Rust backend renames tool aliases.
  const canonical = (ev: SessionEvent) => ev.uiCanonical || ev.functionName;

  const hasBrowser = events.some(
    (ev) =>
      canonical(ev) === "browser" ||
      (canonical(ev)?.startsWith("browser_") ?? false)
  );
  const hasSearch = events.some(
    (ev) => canonical(ev) === "web_search" || canonical(ev) === "WebSearch"
  );
  const hasFetch = events.some(
    (ev) => canonical(ev) === "web_fetch" || canonical(ev) === "WebFetch"
  );

  const iconCls = "text-text-2";
  if (hasSearch && !hasBrowser && !hasFetch)
    return {
      icon: <Globe size={14} className={iconCls} />,
      label: i18next.t("sessions:chat.webSearchGroup"),
    };
  if (hasFetch && !hasBrowser && !hasSearch)
    return {
      icon: <FileSymlink size={14} className={iconCls} />,
      label: i18next.t("sessions:chat.webFetchGroup"),
    };
  if (hasBrowser && !hasSearch && !hasFetch)
    return {
      icon: <Chrome size={14} className={iconCls} />,
      label: i18next.t("sessions:chat.browserGroup"),
    };
  return {
    icon: <Globe size={14} className={iconCls} />,
    label: i18next.t("sessions:chat.webActivityGroup"),
  };
}

export function renderActivityStackGroup(
  chatItem: OptimizedChatItem,
  itemKey: string
): React.ReactElement | null {
  const stackGroup = chatItem.activityStackGroup;
  if (!stackGroup || stackGroup.events.length === 0) return null;

  if (stackGroup.category === "terminal") {
    return (
      <ChatItemWrap key={itemKey}>
        <TerminalActivityGroup
          events={stackGroup.events}
          closedByBoundary={stackGroup.closedByBoundary}
        />
      </ChatItemWrap>
    );
  }

  if (stackGroup.category === "edit") {
    return (
      <ChatItemWrap key={itemKey}>
        <EditActivityGroup
          events={stackGroup.events}
          closedByBoundary={stackGroup.closedByBoundary}
        />
      </ChatItemWrap>
    );
  }

  const actionCount = stackGroup.events.length;
  const countLabel = i18next.t("sessions:chat.actionCount", {
    count: actionCount,
  });
  const { icon, label } = getStackGroupPresentation(stackGroup.events);

  return (
    <ChatItemWrap key={itemKey}>
      <StackedBlock
        items={stackGroup.events}
        icon={icon}
        label={label}
        groupSummary={countLabel}
        defaultCollapsed={false}
        renderItem={(event) => (
          <ToolCallBlock
            toolName={event.functionName || "browser"}
            args={event.args}
            result={event.result}
            eventId={event.id}
            sessionId={event.sessionId}
            payloadRefs={event.payloadRefs}
          />
        )}
      />
    </ChatItemWrap>
  );
}

export function renderThreadSelector(
  chatItem: OptimizedChatItem,
  itemKey: string
): React.ReactElement | null {
  const threadItem = chatItem as unknown as ThreadSelectorChatItem;
  if (!threadItem.threadSelectorData) return null;
  const { threads, threadFirstEventMap } = threadItem.threadSelectorData;
  return (
    <ChatItemWrap key={itemKey}>
      <MemoizedThreadSelector
        threads={threads}
        threadFirstEventMap={threadFirstEventMap}
      />
    </ChatItemWrap>
  );
}

export function renderDefault(
  chatItem: OptimizedChatItem,
  _index: number,
  _itemKey: string
): React.ReactElement | null {
  if (process.env.NODE_ENV === "development") {
    log.warn(
      "[ChatItemRenderer] Unknown chat type, using default:",
      chatItem.type,
      chatItem
    );
  }
  return null;
}
