/**
 * useChatPanelState Hook
 *
 * Description: Handles business logic for the ChatPanel feature
 *
 * Features:
 * - Tab switching between Chat and Changes
 * - Integration with workspace contexts
 * - Chat dropdown state management
 *
 * @example
 * const {
 *   winType,
 *   handleTabChange,
 *   showInteractArea,
 * } = useChatPanelState();
 */
import { useAtom } from "jotai";
import { useCallback, useState } from "react";

import { useChatContext } from "@src/contexts/workspace/ChatContext";
import { useDataContext } from "@src/contexts/workspace/DataContext";
import { useTaskStatus } from "@src/engines/SessionCore";
import { chatDropDownShowAtom } from "@src/store/ui/chatPanelAtom";

// ============================================
// Type Definitions
// ============================================

export interface UseChatPanelOptions {
  // Reserved for future per-surface options.
}

export type ChatPanelTabType = "chat" | "changes";

export interface UseChatPanelReturn {
  // Tab state
  /** Current active tab */
  winType: ChatPanelTabType;
  /** Handle tab change */
  handleTabChange: (key: string) => void;

  // Chat context data
  /** Whether to show the input area */
  showInteractArea: boolean;
  /** Current chat panel width */
  chatWidth: number;
  /** Set chat panel width */
  setChatWidth: (width: number) => void;

  // Session context data
  /** Current workspace task status */
  wpTaskStatus: string;

  // Data context
  /** Repository list */
  regeList: Record<string, string[]>;

  // Dropdown state
  /** Whether chat dropdown is visible */
  chatDropDownShow: boolean;
  /** Set chat dropdown visibility */
  setChatDropDownShow: (show: boolean) => void;
}

// ============================================
// Hook Implementation
// ============================================

/**
 * Custom hook for ChatPanel business logic
 */
export function useChatPanelState(): UseChatPanelReturn {
  // ============================================
  // Contexts
  // ============================================

  const { taskStatus: wpTaskStatus } = useTaskStatus();
  const { showInteractArea, chatWidth, setChatWidth } = useChatContext();
  const { regeList } = useDataContext();

  // ============================================
  // Global State
  // ============================================

  const [chatDropDownShow, setChatDropDownShow] = useAtom(chatDropDownShowAtom);

  // ============================================
  // Local State
  // ============================================

  const [winType, setWinType] = useState<ChatPanelTabType>("chat");

  // ============================================
  // Event Handlers
  // ============================================

  /**
   * Handle tab change between Chat and Changes
   */
  const handleTabChange = useCallback(
    (key: string) => {
      // Close dropdown when switching to Changes tab
      if (key === "changes") {
        setChatDropDownShow(false);
      }

      setWinType(key as ChatPanelTabType);
    },
    [setChatDropDownShow]
  );

  // ============================================
  // Return
  // ============================================

  return {
    // Tab state
    winType,
    handleTabChange,

    // Chat context
    showInteractArea,
    chatWidth,
    setChatWidth,

    // Session context
    wpTaskStatus,

    // Data context
    regeList,

    // Dropdown state
    chatDropDownShow,
    setChatDropDownShow,
  };
}

export default useChatPanelState;
