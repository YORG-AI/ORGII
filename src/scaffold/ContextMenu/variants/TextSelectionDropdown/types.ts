/**
 * TextSelectionDropdown Types
 *
 * TypeScript type definitions for the text selection dropdown.
 */
import type { RefObject } from "react";

import type { SessionItem } from "./config";

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
  /** Container element to watch for selections */
  containerRef?: RefObject<HTMLElement | null>;
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
