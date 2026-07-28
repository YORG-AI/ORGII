/**
 * View Container Tokens
 *
 * Shared class strings and style helpers for view containers (WorkStation,
 * SessionWorkspace) and page panels (MainAppShell, ShellFallback).
 */
import type { CSSProperties } from "react";

import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import {
  sanitizePageOpacity,
  sanitizeSidebarOpacity,
} from "@src/store/ui/backgroundConfigAtom";

const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

/**
 * Shared pane transition. It animates layout dimensions themselves rather
 * than transforms, so ResizeObserver and native-webview measurements see the
 * real intermediate width throughout the motion.
 */
export const PANE_WIDTH_TRANSITION_CLASSES =
  "transition-[width,flex-grow,flex-basis] duration-200 ease-out motion-reduce:transition-none";

interface ChatSlotLayoutStyleOptions {
  maximized: boolean;
  visible: boolean;
  visibleWidth: string | number;
}

/** Normal-flow flex geometry for the chat pane at each visibility state. */
export function getChatSlotLayoutStyle({
  maximized,
  visible,
  visibleWidth,
}: ChatSlotLayoutStyleOptions): CSSProperties {
  if (maximized) {
    return {
      flexBasis: 0,
      flexGrow: 1,
      flexShrink: 1,
      width: 0,
    };
  }

  const width = visible ? visibleWidth : 0;
  return {
    flexBasis: width,
    flexGrow: 0,
    flexShrink: 0,
    pointerEvents: visible ? "auto" : "none",
    width,
  };
}

/** Normal-flow flex geometry for the workstation beside the chat pane. */
export function getWorkbenchLayoutStyle(maximized: boolean): CSSProperties {
  return {
    flexBasis: 0,
    flexGrow: maximized ? 0 : 1,
    flexShrink: 1,
    pointerEvents: maximized ? "none" : "auto",
    width: 0,
  };
}

/**
 * View container class strings for modules/index.tsx
 *
 * `WithBg` suffix preserved for backward-compat in caller code. The
 * surface paint actually arrives via `getPagePanelBackgroundStyle()`
 * applied by MainAppShell / ShellFallback — these classes contribute
 * only geometry. Loading-state callers that mount these containers
 * standalone (outside MainAppShell) keep an explicit `bg-bg-2` token
 * so they don't render transparent.
 */
export const VIEW_CONTAINER_CLASSES = {
  /** Flat Modern container with a background for loading state. */
  withBg: "absolute inset-0 bg-bg-2",
} as const;

/** Style for visibility toggle - prevents flash when switching views */
export function getViewToggleStyle(
  isVisible: boolean,
  zIndexWhenVisible = 10
): CSSProperties {
  return {
    visibility: isVisible ? "visible" : "hidden",
    display: isVisible ? "block" : "none",
    zIndex: isVisible ? zIndexWhenVisible : -1,
  };
}

/** CSS containment for layout isolation - used by outlet containers */
export const LAYOUT_CONTAIN_STYLE: CSSProperties = {
  contain: "layout style",
};

/**
 * Build the inline style for the page panel surface. Always emits a
 * `backgroundColor` (via `color-mix`) so callers can drop the redundant
 * `bg-bg-2` Tailwind class — there's a single source of truth for the
 * surface paint. At 100% opacity the mix collapses to
 * `var(--color-primary-pane-bg)`.
 */
export function getPagePanelBackgroundStyle(
  pageOpacity: number | undefined
): CSSProperties {
  const opacity = IS_MACOS_HOST ? 100 : sanitizePageOpacity(pageOpacity);
  return {
    backgroundColor: `color-mix(in srgb, var(--color-primary-pane-bg) ${opacity}%, transparent)`,
  };
}

/** Same as `getPagePanelBackgroundStyle` but for the sidebar surface. */
export function getSidebarSurfaceBackgroundStyle(
  sidebarOpacity: number | undefined
): CSSProperties {
  const opacity = sanitizeSidebarOpacity(sidebarOpacity);
  return {
    backgroundColor: `color-mix(in srgb, var(--sidebar-bg) ${opacity}%, transparent)`,
  };
}

/**
 * Inline style for the chat panel root. Sets its own background and
 * rebinds `--color-chat-pane` on this subtree so every descendant Tailwind
 * `bg-chat-pane` class (sticky group headers, pagination toolbar wrapper,
 * turn-page list, loading bar, agent-org overview panel, etc.)
 * automatically inherits the same transparency.
 *
 * `--color-chat-container` is intentionally NOT rebound: it backs distinct
 * cards/badges that sit on top of the chat surface (region notices, pinned
 * pop-out cards, inline tool blocks). Those should read as solid surfaces
 * over the wallpaper-tinted chat pane, not also bleed through.
 *
 * The mix reads the shared `--color-primary-pane-bg` token so chat and
 * settings page roots always use the same base color. `--color-chat-pane`
 * remains a consumable alias for descendants and is rebound to the mixed
 * value on this subtree.
 */
export function getChatPanelBackgroundStyle(
  pageOpacity: number | undefined
): CSSProperties {
  const opacity = IS_MACOS_HOST ? 100 : sanitizePageOpacity(pageOpacity);
  const chatPaneMix = `color-mix(in srgb, var(--color-primary-pane-bg) ${opacity}%, transparent)`;
  return {
    backgroundColor: chatPaneMix,
    "--color-chat-pane": chatPaneMix,
  } as CSSProperties;
}
