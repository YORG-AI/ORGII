/**
 * Chat Context - Chat UI State Only
 *
 * ARCHITECTURE: chatHistory is derived from the session store's eventsAtom.
 * This ensures ChatPanel and Simulator use the SAME data source.
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
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import { chatEventsAtom } from "@src/engines/SessionCore/derived/chatEvents";
import {
  chatEventsForSessionAtomFamily,
  sessionScopedPlanningMetaAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { activeSessionIdAtom } from "@src/store/session";
import { chatWidthAtom } from "@src/store/ui/chatPanelAtom";
import { FeedBackInfo } from "@src/types/session/steps";

/**
 * ChatContextType - UI state only.
 *
 * chatHistory was removed from this context to prevent all consumers from
 * re-rendering on every chat event. Use useChatHistory() instead — it reads
 * directly from chatEventsAtom and only triggers the components that need it.
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

/**
 * useChatHistory — read chat events for the active ChatHistory pipeline.
 *
 * Routing rules (prevents subagent-strip race where one cell reads another
 * cell's events):
 *
 * - If a {@link ChatSessionContext} override is present *and* it differs
 *   from the globally-active session, read from
 *   `chatEventsForSessionAtomFamily(sessionId)` — each family entry owns its
 *   own snapshot subscription and `_prev` cache.
 * - Otherwise, fall back to the global `chatEventsAtom` to preserve the
 *   primary ChatPanel behavior (single source of truth bound to the active
 *   session, including the shared streaming-merge cache).
 *
 * Implementation: a single `useAtomValue` reads a per-call selector atom,
 * so React only subscribes to one source at a time. Switching between
 * global and per-session paths (or between two subagent sessions) creates
 * a new selector atom; the prior subscription is released when the
 * selector identity changes. This avoids holding a dangling subscription
 * on a placeholder session id and keeps the per-session family entry
 * mounted only while it is actively rendered.
 */
export const useChatHistory = () => {
  const override = useChatHistoryOverride();
  const contextSessionId = useChatSessionId();
  // `activeSessionIdAtom` is the global chat-pipeline session — the one
  // `chatEventsAtom` is bound to. When ChatSessionContext matches it,
  // both routes return the same data, but the global atom carries the
  // shared streaming-merge cache and is the canonical primary path.
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const usePerSession = Boolean(
    contextSessionId && contextSessionId !== activeSessionId
  );
  const selectorAtom = useMemo(() => {
    if (usePerSession && contextSessionId) {
      const source = chatEventsForSessionAtomFamily(contextSessionId);
      const meta = sessionScopedPlanningMetaAtomFamily(contextSessionId);
      return atom((get) => ({
        chatHistory: get(source),
        sourceSessionId: contextSessionId,
        sourceVersion: get(meta).version,
      }));
    }
    return atom((get) => {
      const snapshot = get(derivedSnapshotAtom);
      const snapshotSessionId =
        snapshot?.lastEvent?.sessionId ??
        snapshot?.chatEvents[0]?.sessionId ??
        null;
      return {
        chatHistory: get(chatEventsAtom),
        // An empty freshly-cleared snapshot is still authoritative for the
        // active pipeline. A non-empty mismatched snapshot remains identifiable
        // so projection never renders another session during a switch.
        sourceSessionId: snapshotSessionId ?? activeSessionId,
        sourceVersion: snapshot?.version ?? 0,
      };
    });
  }, [activeSessionId, usePerSession, contextSessionId]);
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

export const useChatWidth = () => {
  const { chatWidth, setChatWidth } = useChatContext();
  return { chatWidth, setChatWidth };
};

export const useChatScroll = () => {
  const {
    isChatScrolledToBottom,
    setIsChatScrolledToBottom,
    chatContainerRef,
    unreadCount,
    setUnreadCount,
  } = useChatContext();
  return {
    isChatScrolledToBottom,
    setIsChatScrolledToBottom,
    chatContainerRef,
    unreadCount,
    setUnreadCount,
  };
};

export { ChatContext };
