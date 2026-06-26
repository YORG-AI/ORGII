/**
 * TextSelectionDropdown Types
 *
 * TypeScript type definitions for the text selection dropdown.
 */
import type { RefObject } from "react";

import { DropdownAction, SessionItem } from "./config";

// ============================================
// Component Props
// ============================================

export interface TextSelectionDropdownProps {
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Position of the dropdown */
  position: { x: number; y: number };
  /** The selected text content */
  selectedText: string;
  /** Source of the selection: terminal, browser, or editor */
  source: "terminal" | "browser" | "editor";
  /** Callback when dropdown should close */
  onClose: () => void;
  /** Callback when "Ask Agent" is selected */
  onAskAgent?: (text: string) => void;
  /** Callback when "Add to Session Context" is selected with a session */
  onAddToContext?: (text: string, sessionId: string | null) => void;
  onAddFile?: () => void;
  onAddLines?: () => void;
  /** Line numbers for editor selections (optional) */
  lineRange?: { fromLine: number; toLine: number };
  /** Custom class name */
  className?: string;
}

// ============================================
// Hook Types
// ============================================

export interface UseTextSelectionDropdownOptions {
  /** Whether the dropdown functionality is enabled */
  enabled?: boolean;
  /** Container element to watch for selections */
  containerRef?: RefObject<HTMLElement | null>;
  /** Source type for the selection */
  source: "terminal" | "browser" | "editor";
  /** Callback when "Ask Agent" is triggered */
  onAskAgent?: (text: string) => void;
  /** Callback when "Add to Session Context" is triggered */
  onAddToContext?: (text: string, sessionId: string | null) => void;
}

export interface UseTextSelectionDropdownReturn {
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Position for the dropdown */
  position: { x: number; y: number };
  /** Currently selected text */
  selectedText: string;
  /** Show the dropdown at a position */
  showDropdown: (position: { x: number; y: number }, text: string) => void;
  /** Hide the dropdown */
  hideDropdown: () => void;
  /** Handle action selection */
  handleAction: (action: DropdownAction, sessionId?: string | null) => void;
}

// ============================================
// Session Selector Types
// ============================================

export interface SessionSelectorProps {
  /** Available sessions */
  sessions: SessionItem[];
  /** Loading state */
  loading?: boolean;
  /** Currently active/selected session index */
  activeIndex: number;
  /** Callback when session is selected (null = new session) */
  onSelect: (sessionId: string | null) => void;
  /** Callback when hovering over an item */
  onHover: (index: number) => void;
  /** Callback to go back to main menu */
  onBack: () => void;
}
