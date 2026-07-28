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
});

export function createChatSessionTab(
  sessionId: string,
  title: string,
  workItemId?: string,
  workItemShortId?: string
): WorkStationTab {
  return chatSessionTabFactory({
    sessionId,
    title,
    ...(workItemId && { workItemId }),
    ...(workItemShortId && { workItemShortId }),
  });
}
