/**
 * Chat Session Tab Factories
 *
 * Tab factories for chat sessions using defineTabFactory.
 */
import { defineTabFactory } from "../tabFactory";
import type { WorkStationTab } from "../types";

// ============================================
// Chat Session Tab
// ============================================

export interface ChatSessionTabData {
  sessionId: string;
  workItemId?: string;
  workItemShortId?: string;
  /** Exact durable transcript target. Changes must update an existing keyed tab. */
  initialMessageId?: string;
}

export const chatSessionTabFactory = defineTabFactory<
  ChatSessionTabData & { title: string }
>({
  tabType: "chat-session",
  idStrategy: {
    type: "keyed",
    prefix: "chat-session",
    getKey: (data) => data.sessionId,
  },
  getTitle: (data) => data.title,
  icon: "MessageSquare",
});

export function createChatSessionTab(
  sessionId: string,
  title: string,
  workItemId?: string,
  workItemShortId?: string,
  initialMessageId?: string
): WorkStationTab {
  return chatSessionTabFactory({
    sessionId,
    title,
    ...(workItemId && { workItemId }),
    ...(workItemShortId && { workItemShortId }),
    ...(initialMessageId && { initialMessageId }),
  });
}
