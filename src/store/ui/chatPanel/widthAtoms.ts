/**
 * Chat panel width atoms.
 *
 * High-frequency state for the chat pane's dimensions. Jotai instead of
 * Context to avoid excessive re-rendering.
 *
 * This module owns module-level mutable state (`chatWidthSaveTimer`,
 * `lastVisibleChatWidth`) and runs `getInitialChatWidth()` once at import
 * time to seed the CSS variable before any component renders. Keep the whole
 * block together — splitting it would duplicate that initialization.
 */
import { atom } from "jotai";
import { z } from "zod/v4";

import {
  clampChatWidth,
  clampVisibleChatWidth,
} from "@src/engines/ChatPanel/config";

/**
 * Chat width - persisted across sessions
 * Now unified across all views (workstation, session workspace, kanban)
 *
 * OPTIMIZED: Uses debounced localStorage writes to prevent blocking UI
 */

// Debounce timer for localStorage writes
export const DEFAULT_CHAT_WIDTH = 520;

let chatWidthSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastVisibleChatWidth = DEFAULT_CHAT_WIDTH;
const CHAT_WIDTH_SAVE_DELAY = 300; // ms

// CSS variable name for direct DOM updates
const CHAT_WIDTH_CSS_VAR = "--orgii-chat-width";
// Clamp persisted widths to the current responsive range; preserve the 0
// sentinel which means "chat panel hidden".
const ChatWidthSchema = z.number().transform((value) => {
  if (value <= 0) return 0;
  return clampVisibleChatWidth(value);
});

// Load initial value from localStorage (only once at startup).
// Clamp to the responsive width range so values persisted from wider viewports
// don't overflow, and immediately write the clamped value back so the next
// reload is clean.
const getInitialChatWidth = (): number => {
  if (typeof window === "undefined") return DEFAULT_CHAT_WIDTH;
  try {
    const storedValue = localStorage.getItem("globalChatWidth");
    const parsed =
      storedValue !== null ? JSON.parse(storedValue) : DEFAULT_CHAT_WIDTH;
    const width = ChatWidthSchema.safeParse(parsed).data ?? DEFAULT_CHAT_WIDTH;
    if (width !== parsed) {
      localStorage.setItem("globalChatWidth", JSON.stringify(width));
    }
    return width;
  } catch {
    localStorage.setItem("globalChatWidth", JSON.stringify(DEFAULT_CHAT_WIDTH));
    return DEFAULT_CHAT_WIDTH;
  }
};

// Initialize CSS variable on module load (before any component renders)
const initialChatWidth = getInitialChatWidth();
lastVisibleChatWidth =
  initialChatWidth > 0 ? initialChatWidth : DEFAULT_CHAT_WIDTH;
if (typeof document !== "undefined") {
  document.documentElement.style.setProperty(
    CHAT_WIDTH_CSS_VAR,
    `${initialChatWidth}px`
  );
}

// Base atom for in-memory state (fast updates, no persistence)
const chatWidthBaseAtom = atom<number>(initialChatWidth);
chatWidthBaseAtom.debugLabel = "chatWidthBaseAtom";

/** True only while the user is actively resizing the chat pane. */
export const chatPanelDraggingAtom = atom<boolean>(false);
chatPanelDraggingAtom.debugLabel = "chatPanelDraggingAtom";

/**
 * Chat width atom with optimized persistence
 * - Reads from base atom (fast)
 * - Writes update base atom immediately + debounced localStorage write
 * - Also updates CSS variable directly for instant visual feedback
 */
export const chatWidthAtom = atom(
  (get) => get(chatWidthBaseAtom),
  (_get, set, newWidth: number) => {
    const clampedWidth = clampChatWidth(newWidth);

    set(chatWidthBaseAtom, clampedWidth);

    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty(
        CHAT_WIDTH_CSS_VAR,
        `${clampedWidth}px`
      );
    }

    if (clampedWidth <= 0) return;

    lastVisibleChatWidth = clampedWidth;
    if (chatWidthSaveTimer) {
      clearTimeout(chatWidthSaveTimer);
    }
    chatWidthSaveTimer = setTimeout(() => {
      localStorage.setItem("globalChatWidth", JSON.stringify(clampedWidth));
      chatWidthSaveTimer = null;
    }, CHAT_WIDTH_SAVE_DELAY);
  }
);
chatWidthAtom.debugLabel = "chatWidthAtom";

export const restoreChatWidthAtom = atom(null, (_get, set) => {
  set(chatWidthAtom, lastVisibleChatWidth || DEFAULT_CHAT_WIDTH);
});
restoreChatWidthAtom.debugLabel = "restoreChatWidthAtom";

/**
 * Derived atom for chat visibility only
 * OPTIMIZED: Only triggers re-render when visibility changes (0 <-> non-zero)
 * Components that only need to know if chat is visible should use this
 */
export const chatVisibleAtom = atom((get) => get(chatWidthBaseAtom) > 0);
chatVisibleAtom.debugLabel = "chatVisibleAtom";
