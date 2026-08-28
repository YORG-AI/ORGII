/**
 * ChannelFeedPanel
 *
 * Right panel showing the message feed for the selected channel.
 * Messages are grouped by date and displayed in a chronological stream.
 * Bottom composer matches session/chat input styling; floating scroll-to-bottom when not at end.
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import FloatingScrollNav from "@src/components/FloatingScrollNav";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import {
  CHAT_INPUT_CONTAINER_STYLE,
  INPUT_AREA,
  INPUT_AREA_CLASSES,
} from "@src/config/inputAreaTokens";
import {
  Delete02Icon,
  HugeiconsIcon,
  Search01Icon,
  TickDouble01Icon,
} from "@src/icons";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";

import type { InboxCategory, InboxChannelConfig } from "../config";
import type { DateGroup, InboxMessage } from "../types";
import FeedMessage from "./FeedMessage";

interface ChannelFeedPanelProps {
  channelConfig: InboxChannelConfig | undefined;
  dateGroups: DateGroup[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onDeleteMessage: (id: string) => void;
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
  hasUnread: boolean;
}

const ChannelFeedPanel: React.FC<ChannelFeedPanelProps> = ({
  channelConfig,
  dateGroups,
  searchQuery,
  onSearchChange,
  onDeleteMessage: _onDeleteMessage,
  onMarkAsRead,
  onMarkAllAsRead,
  hasUnread,
}) => {
  const { t } = useTranslation();
  const totalMessages = dateGroups.reduce(
    (sum, group) => sum + group.messages.length,
    0
  );

  if (!channelConfig) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={t("inbox.selectChannel")}
      />
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Channel header */}
      <div className={PANEL_HEADER_TOKENS.row}>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[13px] font-semibold text-text-1">
            {t(channelConfig.labelKey)}
          </span>
          <span className="text-[11px] text-text-3">
            {totalMessages} {totalMessages === 1 ? "message" : "messages"}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {hasUnread && (
            <Button
              {...PANEL_HEADER_TOKENS.actionButton}
              icon={
                <HugeiconsIcon
                  icon={TickDouble01Icon}
                  data-icon="check-check"
                  size={PANEL_HEADER_TOKENS.buttonIconSize}
                  strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                />
              }
              title={t("inbox.markAllAsRead")}
              aria-label={t("inbox.markAllAsRead")}
              onClick={onMarkAllAsRead}
            />
          )}
          <div className="w-48">
            <Input
              prefix={
                <HugeiconsIcon
                  icon={Search01Icon}
                  data-icon="search"
                  size={13}
                  strokeWidth={1.75}
                />
              }
              placeholder={t("inbox.searchPlaceholder")}
              value={searchQuery}
              onChange={onSearchChange}
              size="small"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </div>
      </div>

      {/* Feed + scroll-to-bottom + composer (session-style bottom bar) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          {totalMessages === 0 ? (
            <div className="flex h-full items-center justify-center">
              <Placeholder
                variant="empty"
                title={t("inbox.noMessages")}
                subtitle={t("inbox.noMessagesSubtitle")}
              />
            </div>
          ) : (
            <InboxMessageFeed
              channelId={channelConfig.id}
              dateGroups={dateGroups}
              hasUnread={hasUnread}
              onDelete={_onDeleteMessage}
              onMarkAsRead={onMarkAsRead}
              onMarkAllAsRead={onMarkAllAsRead}
            />
          )}
        </div>

        <InboxFeedComposer />
      </div>
    </div>
  );
};

// ============================================
// Message feed — scroll tracking for floating nav buttons
// ============================================

const SCROLL_AT_BOTTOM_THRESHOLD_PX = 80;

function getLatestMessageId(dateGroups: DateGroup[]): string | null {
  for (
    let groupIndex = dateGroups.length - 1;
    groupIndex >= 0;
    groupIndex -= 1
  ) {
    const messages = dateGroups[groupIndex].messages;
    const latestMessage = messages[messages.length - 1];
    if (latestMessage) return latestMessage.id;
  }
  return null;
}

interface InboxMessageFeedProps {
  dateGroups: DateGroup[];
  channelId: InboxCategory;
  hasUnread: boolean;
  onDelete: (id: string) => void;
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
}

const InboxMessageFeed: React.FC<InboxMessageFeedProps> = ({
  dateGroups,
  channelId,
  hasUnread,
  onDelete,
  onMarkAsRead,
  onMarkAllAsRead,
}) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastAutoScrolledChannelRef = useRef<InboxCategory | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const syncAtBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance <= SCROLL_AT_BOTTOM_THRESHOLD_PX);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.addEventListener("scroll", syncAtBottom, { passive: true });
    return () => element.removeEventListener("scroll", syncAtBottom);
  }, [syncAtBottom]);

  const messageCount = useMemo(
    () => dateGroups.reduce((sum, group) => sum + group.messages.length, 0),
    [dateGroups]
  );

  const latestMessageId = useMemo(
    () => getLatestMessageId(dateGroups),
    [dateGroups]
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !latestMessageId) return;
    if (lastAutoScrolledChannelRef.current === channelId) return;

    element.scrollTop = element.scrollHeight;
    lastAutoScrolledChannelRef.current = channelId;
  }, [channelId, latestMessageId]);

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, []);

  const scrollToFirstUnread = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const firstUnread = element.querySelector<HTMLElement>(
      "[data-unread='true']"
    );
    if (firstUnread) {
      firstUnread.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);

  return (
    <>
      <div
        ref={scrollRef}
        className="scrollbar-overlay h-full min-h-0 overflow-y-auto"
      >
        <div className="py-3">
          {dateGroups.map((group) => (
            <DateGroupSection
              key={group.dateKey}
              group={group}
              onDelete={onDelete}
              onMarkAsRead={onMarkAsRead}
            />
          ))}
        </div>
      </div>

      <FloatingScrollNav
        showScrollToBottom={!atBottom && messageCount > 0}
        onScrollToBottom={scrollToBottom}
        markAllAsRead={
          hasUnread
            ? {
                label: t("inbox.markAllAsRead"),
                onClick: onMarkAllAsRead,
              }
            : undefined
        }
        catchUp={
          hasUnread
            ? { label: t("inbox.scrollToUnread"), onClick: scrollToFirstUnread }
            : undefined
        }
      />
    </>
  );
};

// ============================================
// Bottom composer — session / chat panel container styling
// ============================================

const InboxFeedComposer: React.FC = () => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  return (
    <div className="flex w-full shrink-0 flex-col px-2 pb-2 pt-1">
      <div
        className={`w-full ${INPUT_AREA_CLASSES.containerChatPanel} ${INPUT_AREA.shellInteractionClasses}`}
        style={CHAT_INPUT_CONTAINER_STYLE}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("inbox.composerPlaceholder")}
          rows={2}
          className={`max-h-[200px] min-h-[60px] w-full resize-none bg-transparent px-2 py-2 text-[14px] text-text-1 outline-none placeholder:text-text-3 ${INPUT_AREA_CLASSES.editorInner}`}
          autoComplete="off"
          spellCheck={true}
        />
      </div>
    </div>
  );
};

// ============================================
// Date group section with separator
// ============================================

interface DateGroupSectionProps {
  group: DateGroup;
  onDelete: (id: string) => void;
  onMarkAsRead: (id: string) => void;
}

const DateGroupSection: React.FC<DateGroupSectionProps> = ({
  group,
  onDelete,
  onMarkAsRead,
}) => {
  return (
    <div className="mb-2">
      <div className="sticky top-0 z-30 flex items-center gap-3 bg-bg-2 px-4 py-3">
        <div className="h-px flex-1 bg-border-2" />
        <span className="shrink-0 text-[11px] font-medium text-primary-6">
          {group.label}
        </span>
        <div className="h-px flex-1 bg-border-2" />
      </div>

      {group.messages.map((message) => (
        <FeedMessageWithActions
          key={message.id}
          message={message}
          onDelete={onDelete}
          onMarkAsRead={onMarkAsRead}
        />
      ))}
    </div>
  );
};

// ============================================
// Message wrapper with hover actions
// ============================================

interface FeedMessageWithActionsProps {
  message: InboxMessage;
  onDelete: (id: string) => void;
  onMarkAsRead: (id: string) => void;
}

const FeedMessageWithActions: React.FC<FeedMessageWithActionsProps> = ({
  message,
  onDelete,
  onMarkAsRead,
}) => {
  const { t } = useTranslation();
  const elementRef = useRef<HTMLDivElement>(null);
  const messageId = message.id;
  const isUnread = message.status === "unread";

  useEffect(() => {
    if (!isUnread) return;
    const element = elementRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onMarkAsRead(messageId);
          observer.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [isUnread, messageId, onMarkAsRead]);

  const handleDelete = useCallback(() => {
    onDelete(messageId);
  }, [messageId, onDelete]);

  const deleteButton = (
    <div className="pointer-events-none absolute left-full top-0 z-10 ml-1.5 hidden group-hover/msg:pointer-events-auto group-hover/msg:flex">
      <Button
        size="small"
        variant="secondary"
        shape="square"
        iconOnly
        icon={
          <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={14} />
        }
        title={t("common:actions.delete")}
        aria-label={t("common:actions.delete")}
        onClick={handleDelete}
      />
    </div>
  );

  return (
    <div
      ref={elementRef}
      data-unread={isUnread}
      className="group/msg w-fit max-w-full"
    >
      <FeedMessage message={message} bubbleOutsideActions={deleteButton} />
    </div>
  );
};

export default ChannelFeedPanel;
