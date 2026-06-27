/**
 * ChatPanel Configuration Constants
 */

// CSS variable for chat width
export const CHAT_WIDTH_CSS_VAR = "--orgii-chat-width";

// Resize constraints
export const MIN_WIDTH = 420;
export const MAX_WIDTH_RATIO = 0.5;
export const LEFT_PANEL_WIDTH = 64; // Navigation sidebar width
export const CHAT_PANEL_LAYOUT_GUTTER = 20;

export function getChatMaxWidth(viewportWidth?: number): number {
  const width =
    viewportWidth ??
    (typeof window !== "undefined" ? window.innerWidth : MIN_WIDTH * 2);
  const availableWidth = Math.max(
    MIN_WIDTH,
    width - LEFT_PANEL_WIDTH - CHAT_PANEL_LAYOUT_GUTTER
  );
  return Math.max(MIN_WIDTH, Math.floor(availableWidth * MAX_WIDTH_RATIO));
}

export function clampVisibleChatWidth(
  value: number,
  viewportWidth?: number
): number {
  return Math.min(Math.max(value, MIN_WIDTH), getChatMaxWidth(viewportWidth));
}

export function clampChatWidth(value: number, viewportWidth?: number): number {
  return value > 0 ? clampVisibleChatWidth(value, viewportWidth) : value;
}

// Timing constants
export const RAPID_CLICK_THRESHOLD_MS = 300;
