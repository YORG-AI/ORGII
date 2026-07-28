import type { InteractionType } from "./apiTrackerTypes";

const INTERACTION_WINDOW_MS = 500;

let recentInteraction: {
  type: InteractionType;
  timestamp: number;
} | null = null;

export function detectInteractionType(): InteractionType {
  if (!recentInteraction) return "auto";

  const timeSinceInteraction = Date.now() - recentInteraction.timestamp;
  if (timeSinceInteraction > INTERACTION_WINDOW_MS) return "auto";

  return recentInteraction.type;
}

function trackClick(): void {
  recentInteraction = { type: "click", timestamp: Date.now() };
}

function trackHover(): void {
  recentInteraction = { type: "hover", timestamp: Date.now() };
}

function trackKeyboard(): void {
  recentInteraction = { type: "keyboard", timestamp: Date.now() };
}

function trackFocus(): void {
  recentInteraction = { type: "focus", timestamp: Date.now() };
}

export function installInteractionTracking(): void {
  if (typeof window === "undefined") return;
  document.addEventListener("click", trackClick, true);
  document.addEventListener("mouseover", trackHover, true);
  document.addEventListener("keydown", trackKeyboard, true);
  document.addEventListener("focus", trackFocus, true);
}

/** Remove all interaction tracking listeners (call on app teardown). */
export function cleanupInteractionTracking(): void {
  document.removeEventListener("click", trackClick, true);
  document.removeEventListener("mouseover", trackHover, true);
  document.removeEventListener("keydown", trackKeyboard, true);
  document.removeEventListener("focus", trackFocus, true);
}
