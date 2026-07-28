/**
 * Chat History State Hook
 *
 * Extracts all state management logic from ChatHistory component.
 * Manages:
 * - Chat history data from context
 * - virtual list ref for scroll control
 * - Scroll state (atBottom)
 * - Visible range tracking
 * - Chat appearance settings
 * - Handler refs for stable callbacks
 */
import { useAtomValue } from "jotai";
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  useChatHistory,
  useChatHistoryActions,
} from "@src/contexts/workspace/ChatContext";
import useReplyQuestion from "@src/engines/ChatPanel/hooks/useReplyQuestion";
import {
  isExploringAtom,
  loadErrorAtom,
  loadStatusAtom,
} from "@src/engines/SessionCore";
import type { SessionLoadStatus } from "@src/engines/SessionCore";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { useAgentWorkingRef } from "@src/hooks/streaming";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";

import type { ChatHistoryListHandle } from "../components/ChatHistoryList";

// ============================================
// Helpers
// ============================================

/** Keep a ref in sync with a value — avoids repeating the useRef + useEffect pattern */
function useSyncRef<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

// ============================================
// Props Interface
// ============================================

export type UseChatHistoryStateProps = Record<string, never>;

// ============================================
// Return Type
// ============================================

export interface UseChatHistoryStateReturn {
  // Chat data (raw events from chatEventsAtom — pipeline creates OptimizedChatItem[])
  chatHistory: SessionEvent[];
  chatHistorySourceIsOverride: boolean;
  chatHistorySourceSessionId: string | null;
  chatHistorySourceVersion: number;

  // Refs
  chatContainerRef: RefObject<HTMLDivElement | null>;
  virtualListRef: RefObject<ChatHistoryListHandle | null>;
  isWpGeneWorkingRef: MutableRefObject<boolean>;
  isExploringRef: MutableRefObject<boolean>;
  handleReplyQuestionRef: MutableRefObject<
    (params: { reply: string; chunk_id: string }) => void
  >;
  handleIgnoreQuestionRef: MutableRefObject<(eventId: string) => void>;

  // Scroll state
  atBottom: boolean;
  setAtBottom: Dispatch<SetStateAction<boolean>>;
  visibleRange: { startIndex: number; endIndex: number };
  setVisibleRange: Dispatch<
    SetStateAction<{ startIndex: number; endIndex: number }>
  >;

  // Appearance (focused atoms — only layout props, not animation settings)
  chatFontSize: number;
  chatCodeFontSize: number;
  chatLineHeight: number;
  codeBlockContainerWidth?: number;

  // Session loading
  sessionLoadStatus: SessionLoadStatus;
  sessionLoadError: string | null;

  // Callbacks from context
  setIsChatScrolledToBottom: (bottom: boolean) => void;
}

// ============================================
// Hook
// ============================================

export function useChatHistoryState(
  _props: UseChatHistoryStateProps = {}
): UseChatHistoryStateReturn {
  // ============================================
  // Context & Atoms
  // ============================================

  const {
    chatHistory,
    sourceIsOverride: chatHistorySourceIsOverride,
    sourceSessionId: chatHistorySourceSessionId,
    sourceVersion: chatHistorySourceVersion,
  } = useChatHistory();
  const { setIsChatScrolledToBottom, chatContainerRef } =
    useChatHistoryActions();

  const isExploring = useAtomValue(isExploringAtom);
  const sessionLoadStatus = useAtomValue(loadStatusAtom);
  const sessionLoadError = useAtomValue(loadErrorAtom);
  // Colocated subscription: read agent working state via EventStore selector
  // instead of isSessionActiveAtom to avoid unnecessary re-renders.
  const isWpGeneWorkingRef = useAgentWorkingRef();
  const chatFontSize = useAtomValue(chatFontSizeAtom);
  const chatCodeFontSize = useAtomValue(chatCodeFontSizeAtom);
  const chatLineHeight = useAtomValue(chatLineHeightAtom);
  const { handleReplyQuestion, handleIgnoreQuestion } = useReplyQuestion();

  // ============================================
  // Local State
  // ============================================

  const virtualListRef = useRef<ChatHistoryListHandle>(null);

  // Track whether should auto-scroll to bottom
  const [atBottom, setAtBottom] = useState(true);

  // Track current visible range (for pinned question auto-adaptation)
  const [visibleRange, setVisibleRange] = useState({
    startIndex: 0,
    endIndex: 0,
  });

  // ============================================
  // Computed Values
  // ============================================

  // PERFORMANCE OPTIMIZATION: Don't subscribe to chatWidthAtom
  // Code blocks will use 100% width (their default behavior)
  // The actual width is controlled by CSS - parent container handles sizing
  // ChatCodeBlock already has fallback: `width: containerWidth || "100%"`
  // ModernCodeViewer already has default: `width = "100%"`
  const codeBlockContainerWidth = undefined;

  // ============================================
  // Refs for Stable Callbacks
  // ============================================

  // PERFORMANCE OPTIMIZATION: Store handler references in refs for stable callback identity
  // This prevents renderChatItem from being recreated when these handlers change

  const handleIgnoreQuestionRef = useSyncRef(handleIgnoreQuestion);
  const isExploringRef = useSyncRef(isExploring);
  const handleReplyQuestionRef = useSyncRef(handleReplyQuestion);

  // ============================================
  // Return
  // ============================================

  return {
    chatHistory,
    chatHistorySourceIsOverride,
    chatHistorySourceSessionId,
    chatHistorySourceVersion,

    // Refs
    chatContainerRef,
    virtualListRef,
    isWpGeneWorkingRef,
    isExploringRef,
    handleReplyQuestionRef,
    handleIgnoreQuestionRef,

    // Scroll state
    atBottom,
    setAtBottom,
    visibleRange,
    setVisibleRange,

    // Appearance (focused atoms)
    chatFontSize,
    chatCodeFontSize,
    chatLineHeight,
    codeBlockContainerWidth,

    // Session loading
    sessionLoadStatus,
    sessionLoadError,

    // Callbacks from context
    setIsChatScrolledToBottom,
  };
}
