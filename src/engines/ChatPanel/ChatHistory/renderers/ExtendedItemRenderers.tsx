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
import React from "react";

import ToolCallBlock from "@src/engines/ChatPanel/blocks/ToolCallBlock";
import { StackedBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { useStreamingDeltaForSession } from "@src/engines/SessionCore";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import {
  InternetIcon as Chrome,
  FileSymlinkIcon as FileSymlink,
  InternetIcon as Globe,
  HugeiconsIcon,
} from "@src/icons";

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

const ActivityRowShell: React.FC<{
  event: SessionEvent;
  index: number;
  itemKey: string;
}> = ({ event, index, itemKey }) => {
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
    </ChatItemWrap>
  );
};

// Only the synthetic-live activity row consumes the streaming delta — and only
// to decide whether any text has arrived yet. Isolating the subscription here
// stops a token flush from re-rendering every other (static) activity row in
// the visible window.
const LiveActivityRow: React.FC<{
  event: SessionEvent;
  index: number;
  itemKey: string;
}> = ({ event, index, itemKey }) => {
  const sessionId = useAtomValue(sessionIdAtom);
  const liveDelta = useStreamingDeltaForSession(sessionId);
  const streamingContent =
    liveDelta?.kind === "message" ? liveDelta.content : undefined;

  if (!streamingContent?.trim()) return null;

  return <ActivityRowShell event={event} index={index} itemKey={itemKey} />;
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

  if (isSyntheticLiveActivity(event)) {
    return (
      <LiveActivityRow
        key={itemKey}
        event={event}
        index={index}
        itemKey={itemKey}
      />
    );
  }

  return (
    <ActivityRowShell
      key={itemKey}
      event={event}
      index={index}
      itemKey={itemKey}
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
      icon: (
        <HugeiconsIcon
          icon={Globe}
          data-icon="globe"
          size={14}
          className={iconCls}
        />
      ),
      label: i18next.t("sessions:chat.webSearchGroup"),
    };
  if (hasFetch && !hasBrowser && !hasSearch)
    return {
      icon: (
        <HugeiconsIcon
          icon={FileSymlink}
          data-icon="file-symlink"
          size={14}
          className={iconCls}
        />
      ),
      label: i18next.t("sessions:chat.webFetchGroup"),
    };
  if (hasBrowser && !hasSearch && !hasFetch)
    return {
      icon: (
        <HugeiconsIcon
          icon={Chrome}
          data-icon="chrome"
          size={14}
          className={iconCls}
        />
      ),
      label: i18next.t("sessions:chat.browserGroup"),
    };
  return {
    icon: (
      <HugeiconsIcon
        icon={Globe}
        data-icon="globe"
        size={14}
        className={iconCls}
      />
    ),
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
