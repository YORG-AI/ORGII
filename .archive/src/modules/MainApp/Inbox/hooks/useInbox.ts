/**
 * useInbox Hook
 *
 * Orchestrates inbox state for the channel-based view:
 * - DB hydration + seeding for the static channels (Git, Work Items,
 *   Promotions).
 * - Live git status sync (delegated to `useInboxGitSync`).
 * - Channel selection + message grouping by date.
 * - Search filtering within the selected channel.
 *
 * Agent Teams are loaded separately by `useInboxOrgs` — they don't share
 * the static-channel persistence layer, just the left-list UI.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  deleteInboxMessageAtom,
  inboxDbLoadedAtom,
  inboxDbMessagesAtom,
  loadInboxAtom,
  updateInboxStatusAtom,
  upsertInboxMessageAtom,
} from "@src/store/ui/inboxAtom";

import {
  type InboxCategory,
  formatDateGroupLabel,
  getChannelConfig,
  getDateKey,
} from "../config";
import type { DateGroup, InboxMessage } from "../types";
import { SEED_MESSAGES } from "./converters";
import { useInboxGitSync } from "./useInboxGitSync";

export function useInbox() {
  const dbMessages = useAtomValue(inboxDbMessagesAtom);
  const dbLoaded = useAtomValue(inboxDbLoadedAtom);
  const loadInbox = useSetAtom(loadInboxAtom);
  const upsertMessage = useSetAtom(upsertInboxMessageAtom);
  const updateStatus = useSetAtom(updateInboxStatusAtom);
  const deleteMessage = useSetAtom(deleteInboxMessageAtom);

  const { liveGitMessages, markLiveAsRead } = useInboxGitSync({ dbLoaded });

  const [activeChannelId, setActiveChannelId] = useState<InboxCategory | null>(
    null
  );
  const [searchQuery, setSearchQuery] = useState("");

  // ============================================
  // DB hydration + seeding
  // ============================================

  const seededRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    if (!dbLoaded && !cancelled) {
      loadInbox();
    }
    return () => {
      cancelled = true;
    };
  }, [dbLoaded, loadInbox]);

  useEffect(() => {
    if (!dbLoaded || seededRef.current) return;
    seededRef.current = true;

    if (dbMessages.length === 0) {
      for (const seed of SEED_MESSAGES) {
        upsertMessage(seed);
      }
    }
  }, [dbLoaded, dbMessages.length, upsertMessage]);

  // ============================================
  // Merge: DB + live git status
  // ============================================

  const allMessages = useMemo(() => {
    const seenIds = new Set<string>();
    const merged: InboxMessage[] = [];

    for (const msg of liveGitMessages) {
      seenIds.add(msg.id);
      merged.push(msg);
    }
    for (const msg of dbMessages) {
      if (!seenIds.has(msg.id)) {
        merged.push(msg);
      }
    }

    return merged.sort(
      (msgA, msgB) =>
        new Date(msgA.createdAt).getTime() - new Date(msgB.createdAt).getTime()
    );
  }, [liveGitMessages, dbMessages]);

  // ============================================
  // Channel filtering + search
  // ============================================

  const channelMessages = useMemo(() => {
    return allMessages.filter((message) => {
      if (message.category !== activeChannelId) return false;
      if (searchQuery.trim()) {
        const search = searchQuery.toLowerCase();
        if (
          !message.title.toLowerCase().includes(search) &&
          !message.preview.toLowerCase().includes(search)
        )
          return false;
      }
      return true;
    });
  }, [allMessages, activeChannelId, searchQuery]);

  // ============================================
  // Group messages by date
  // ============================================

  const dateGroups = useMemo((): DateGroup[] => {
    const groupMap = new Map<string, InboxMessage[]>();

    for (const msg of channelMessages) {
      const key = getDateKey(msg.createdAt);
      const existing = groupMap.get(key);
      if (existing) {
        existing.push(msg);
      } else {
        groupMap.set(key, [msg]);
      }
    }

    return [...groupMap.entries()].map(([dateKey, messages]) => ({
      dateKey,
      label: formatDateGroupLabel(messages[0].createdAt),
      messages,
    }));
  }, [channelMessages]);

  // ============================================
  // Unread counts per channel
  // ============================================

  const unreadCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const msg of allMessages) {
      if (msg.status === "unread") {
        counts[msg.category] = (counts[msg.category] ?? 0) + 1;
      }
    }
    return counts;
  }, [allMessages]);

  // ============================================
  // Latest message preview per channel — drives the second line on
  // each row in `ChannelListPanel`. Walking `allMessages` in reverse so
  // the first hit per category is the newest, then snapshotting just
  // the preview text so consumers don't re-render when other fields
  // (status, labels, …) change.
  // ============================================

  const lastMessageByChannel = useMemo(() => {
    const result: Record<string, string> = {};
    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const msg = allMessages[i];
      if (result[msg.category] === undefined) {
        result[msg.category] = msg.preview;
      }
    }
    return result;
  }, [allMessages]);

  // ============================================
  // Handlers
  // ============================================

  const selectChannel = useCallback((channelId: InboxCategory) => {
    setActiveChannelId(channelId);
    setSearchQuery("");
  }, []);

  const handleDeleteMessage = useCallback(
    (id: string) => {
      deleteMessage(id);
    },
    [deleteMessage]
  );

  const handleMarkAsRead = useCallback(
    (id: string) => {
      markLiveAsRead(id);
      updateStatus({ id, status: "read" });
    },
    [updateStatus, markLiveAsRead]
  );

  const handleMarkAllAsRead = useCallback(() => {
    const unreadInChannel = allMessages.filter(
      (msg) => msg.status === "unread" && msg.category === activeChannelId
    );
    for (const msg of unreadInChannel) {
      markLiveAsRead(msg.id);
      updateStatus({ id: msg.id, status: "read" });
    }
  }, [allMessages, activeChannelId, updateStatus, markLiveAsRead]);

  const activeChannelConfig =
    activeChannelId !== null ? getChannelConfig(activeChannelId) : undefined;

  return {
    activeChannelId,
    activeChannelConfig,
    dateGroups,
    unreadCounts,
    lastMessageByChannel,
    searchQuery,
    dbLoaded,

    selectChannel,
    handleDeleteMessage,
    handleMarkAsRead,
    handleMarkAllAsRead,
    setSearchQuery,
  };
}
