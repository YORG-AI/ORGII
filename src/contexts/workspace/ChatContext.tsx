/**
 * Chat Context - Chat UI State Only
 *
 * ARCHITECTURE: chatHistory is derived from
 * `chatEventsForSessionAtomFamily`. ChatPanel and scoped surfaces share
 * that per-session snapshot channel.
 *
 * This context contains ONLY UI-related state:
 * - Chat panel width, scroll state, unread count
 * - Input area visibility
 * - Model selection
 * - Feedback UI state
 *
 * Reply-banner state is NOT here. The persisted
 * `Session.replyTargetEventId` column is the single source of truth
 * for the composer's reply banner; the input area reads/clears it
 * via `useSessionReplyField` (see
 * `src/hooks/session/useSessionPatch.ts`).
 *
 * PERFORMANCE OPTIMIZATION:
 * - Setters are stable references (from useState/useCallback) and don't trigger re-renders
 * - Only values that change are in useMemo dependencies
 * - chatContainerRef is stable (useRef)
 */
import { atom, useAtom, useAtomValue } from "jotai";
import React, {
  ReactNode,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { useChatHistoryOverride } from "@src/engines/ChatPanel/ChatHistoryOverrideContext";
import { useChatSessionId } from "@src/engines/ChatPanel/ChatSessionContext";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createChatTranscriptVersionTracker } from "@src/engines/SessionCore/derived/chatTranscriptStructure";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { activeSessionIdAtom } from "@src/store/session";
import { chatWidthAtom } from "@src/store/ui/chatPanelAtom";
import { FeedBackInfo } from "@src/types/session/steps";

/**
 * ChatContextType - UI state only.
 *
 * chatHistory was removed from this context to prevent all consumers from
 * re-rendering on every chat event. Use useChatHistory() instead — it reads
 * directly from the session-scoped chat-events family and only triggers
 * the components that need it.
 */
export interface ChatContextType {
  // Chat UI state
  chatWidth: number;
  setChatWidth: (width: number) => void;
  unreadCount: number;
  setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
  isChatScrolledToBottom: boolean;
  setIsChatScrolledToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;

  // Input area state
  showInteractArea: boolean;
  setShowInteractArea: React.Dispatch<React.SetStateAction<boolean>>;

  // Feedback state
  feedBackInfo: FeedBackInfo;
  setFeedBackInfo: React.Dispatch<React.SetStateAction<FeedBackInfo>>;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

interface ChatHistoryActionsContextType {
  setIsChatScrolledToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  chatContainerRef: React.RefObject<HTMLDivElement | null>;
}

const ChatHistoryActionsContext = createContext<
  ChatHistoryActionsContextType | undefined
>(undefined);

const ShowInteractAreaContext = createContext<boolean | undefined>(undefined);

// Generate unique ID for each provider instance
let providerInstanceId = 0;

export const ChatProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  // Track provider instance ID (for debugging)
  const _instanceIdRef = useRef(++providerInstanceId);

  // Use Jotai atom for chatWidth to enable global access from outside provider
  const [chatWidth, setChatWidth] = useAtom(chatWidthAtom);

  // UI state - setters from useState are inherently stable
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [isChatScrolledToBottom, setIsChatScrolledToBottom] =
    useState<boolean>(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [showInteractArea, setShowInteractArea] = useState(true);
  const [feedBackInfo, setFeedBackInfo] = useState<FeedBackInfo>({
    isFeedBack: false,
  });

  // PERFORMANCE: Separate stable setters object (never changes)
  // This allows consumers to destructure setters without triggering re-renders
  const stableSetters = useMemo(
    () => ({
      setChatWidth,
      setUnreadCount,
      setIsChatScrolledToBottom,
      setShowInteractArea,
      setFeedBackInfo,
      chatContainerRef, // ref is stable
    }),
    [setChatWidth]
  );

  const historyActionsValue = useMemo(
    () => ({
      setIsChatScrolledToBottom,
      chatContainerRef,
    }),
    [setIsChatScrolledToBottom, chatContainerRef]
  );

  // PERFORMANCE: Only re-create value object when actual values change
  // Setters are spread from stable object to avoid recreation
  const value = useMemo(
    () => ({
      chatWidth,
      unreadCount,
      isChatScrolledToBottom,
      showInteractArea,
      feedBackInfo,
      ...stableSetters,
    }),
    [
      chatWidth,
      unreadCount,
      isChatScrolledToBottom,
      showInteractArea,
      feedBackInfo,
      stableSetters,
    ]
  );

  return (
    <ShowInteractAreaContext.Provider value={showInteractArea}>
      <ChatHistoryActionsContext.Provider value={historyActionsValue}>
        <ChatContext.Provider value={value}>{children}</ChatContext.Provider>
      </ChatHistoryActionsContext.Provider>
    </ShowInteractAreaContext.Provider>
  );
};

export const useChatContext = () => {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within a ChatProvider");
  }
  return context;
};

export const useChatHistoryActions = () => {
  const context = useContext(ChatHistoryActionsContext);
  if (!context) {
    throw new Error("useChatHistoryActions must be used within a ChatProvider");
  }
  return context;
};

export const useShowInteractArea = () => {
  const context = useContext(ShowInteractAreaContext);
  if (context === undefined) {
    throw new Error("useShowInteractArea must be used within a ChatProvider");
  }
  return context;
};

const EMPTY_CHAT_HISTORY: never[] = [];

export interface ChatHistorySource {
  chatHistory: SessionEvent[];
  sourceSessionId: string | null;
  sourceVersion: number;
}

const EMPTY_CHAT_HISTORY_SOURCE: ChatHistorySource = {
  chatHistory: EMPTY_CHAT_HISTORY,
  sourceSessionId: null,
  sourceVersion: 0,
};

/**
 * useChatHistory — read chat events for the active ChatHistory pipeline.
 *
 * Always reads `chatEventsForSessionAtomFamily(sessionId)` so the primary
 * ChatPanel and scoped surfaces share one derivation. `sourceVersion` is a
 * structural transcript version (event ids / non-token fields), not the
 * snapshot mutation counter, so streaming tokens do not resync projection.
 *
 * Implementation: a single `useAtomValue` reads a per-call selector atom.
 * Switching sessions creates a new selector; the prior family subscription
 * is released when the selector identity changes.
 */
export const useChatHistory = () => {
  const override = useChatHistoryOverride();
  const contextSessionId = useChatSessionId();
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const sessionId = contextSessionId ?? activeSessionId ?? null;
  const selectorAtom = useMemo(() => {
    if (!sessionId) {
      return atom(() => EMPTY_CHAT_HISTORY_SOURCE);
    }
    const source = chatEventsForSessionAtomFamily(sessionId);
    const versionTracker = createChatTranscriptVersionTracker();
    let previous: ChatHistorySource | null = null;
    return atom((get): ChatHistorySource => {
      const chatHistory = get(source);
      const next: ChatHistorySource = {
        chatHistory,
        sourceSessionId: sessionId,
        sourceVersion: versionTracker.next(chatHistory),
      };
      if (
        previous &&
        previous.chatHistory === next.chatHistory &&
        previous.sourceSessionId === next.sourceSessionId &&
        previous.sourceVersion === next.sourceVersion
      ) {
        return previous;
      }
      previous = next;
      return next;
    });
  }, [sessionId]);
  const atomSource = useAtomValue(selectorAtom);
  // Override takes precedence: lets a parent (e.g. the subagent grid
  // cell) inject a cursor-sliced event array so ChatHistory renders only
  // events up to the replay timestamp without us touching the shared
  // atom family or its `_prev` cache.
  const chatHistory = override ?? atomSource.chatHistory;
  return {
    chatHistory,
    sourceIsOverride: override !== undefined,
    sourceSessionId: atomSource.sourceSessionId,
    sourceVersion: atomSource.sourceVersion,
  };
};

export { ChatContext };
