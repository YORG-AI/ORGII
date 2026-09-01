/**
 * Popup/Overlay Tokens
 *
 * Shared styling tokens for popups, dropdowns, and overlays.
 * Used across: Spotlight, Selectors, Launchpad, AILauncher, EllipsisDropdown, etc.
 */

// ============================================
// Shadow Tokens
// ============================================

/**
 * Standard popup shadow - used for all floating UI elements
 * Provides depth and separation from the background
 */
export const POPUP_SHADOW =
  "0 20px 50px rgba(0, 0, 0, 0.3), 0 8px 20px rgba(0, 0, 0, 0.2)";

// ============================================
// Animation Tokens
// ============================================

/**
 * Standard popup animation for framer-motion
 */
export const POPUP_ANIMATION = {
  initial: { opacity: 0, y: -8, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -8, scale: 0.96 },
  transition: { duration: 0.15, ease: "easeOut" as const },
};
