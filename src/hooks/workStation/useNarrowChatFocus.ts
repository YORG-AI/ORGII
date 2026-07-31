/**
 * Auto-maximize the docked chat panel when the WorkStation / Agent
 * Station *workbench* (the area to the right of the global sidebar
 * and to the left of the docked chat panel — where the editor /
 * browser / launchpad / kanban / agent surface actually renders) is
 * too narrow to be usable.
 *
 * The breakpoint deliberately tracks the workbench width, NOT the OS
 * window width and NOT the full content column to the right of the
 * sidebar. So:
 *
 * - Dragging the chat handle wider shrinks the workbench → can flip
 *   into a maximized chat slot once it crosses below the breakpoint.
 * - Collapsing the sidebar widens the workbench → can flip the chat
 *   slot back out of maximized.
 * - Resizing the OS window changes everything proportionally, so it
 *   feels "window-driven" too — but only because the workbench is a
 *   downstream of those layout choices.
 *
 * Below `NARROW_CHAT_FOCUS_BREAKPOINT_PX`, `chatPanelMaximizedAtom`
 * is forced to `true` (the same maximized layout the toolbar's
 * maximize button produces). When the workbench grows back above the
 * breakpoint, the flag is cleared — but only if it was *this* hook
 * that set it on the last wide→narrow edge. Manual maximize /
 * un-maximize actions taken while narrow are preserved across the
 * next resize.
 *
 * Width sources (two of them, switched on the maximized flag):
 *
 * - Normal layout: `[data-workbench-surface]` is the children-wrapping
 *   div, sized exactly to the visible workbench. Its
 *   `contentRect.width` IS the workbench width.
 *
 * - Maximized layout: the workbench surface is forcibly collapsed to
 *   `w-0` by `AppLayout` so any inline native webview hosted inside
 *   it shrinks to a zero-area frame (WKWebViews are window-level
 *   sibling NSViews, not DOM children, so this is the only way to
 *   keep them mounted without painting through the React chat
 *   panel). The element's measured width is therefore ~0 and would
 *   immediately trip the restore branch, creating a feedback loop.
 *   So while maximized we compute the *projected* workbench width
 *   from `[data-main-content].contentRect.width - chatWidth`, which
 *   models "what the workbench width would be if chat were docked
 *   normally". Stable across maximize toggles.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  chatPanelMaximizedAtom,
  chatVisibleAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

/**
 * Below this *workbench* width the chat panel takes over the entire
 * content area. Calibrated so the workbench enters the maximized
 * layout once it gets narrower than a phone-sized strip — i.e. it
 * can no longer usefully host the editor / launchpad / etc.
 * alongside the docked chat. Tune here if the workbench surfaces
 * become more or less tolerant of narrow widths.
 */
export const NARROW_CHAT_FOCUS_BREAKPOINT_PX = 480;

/**
 * Selector for the workbench surface: the children-wrapping div that
 * does NOT include the docked chat panel.
 */
const WORKBENCH_SELECTOR = "[data-workbench-surface]";

/**
 * Selector for the main content column (sidebar's flex sibling). Its
 * inner content box (`contentRect.width`) is what we use to derive a
 * projected workbench width while the maximized layout distorts the
 * workbench surface itself.
 */
const MAIN_CONTENT_SELECTOR = "[data-main-content]";

/**
 * Polling interval (ms) used while we wait for the workbench element
 * to mount. ResizeObserver can only attach to an existing element,
 * and the AppShell mounts before the WorkStation tree on the first
 * render that sets `enabled = true`. The retry stops as soon as both
 * elements exist.
 */
const SURFACE_LOOKUP_INTERVAL_MS = 120;

interface UseNarrowChatFocusOptions {
  /** Only run while a WorkStation / Agent Station route is active. */
  enabled: boolean;
}

export function useNarrowChatFocus({
  enabled,
}: UseNarrowChatFocusOptions): void {
  const stationMode = useAtomValue(stationModeAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const chatVisible = useAtomValue(chatVisibleAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);

  // Edge-triggered state machine. We only flip the maximized flag on
  // a *transition* across the breakpoint:
  //
  // - `wasNarrowRef` remembers the side of the breakpoint at the
  //   last evaluation.
  // - `autoTriggeredRef` remembers whether we were the one that
  //   maximized on the last wide→narrow edge. Cleared on restore and
  //   on manual un-maximize while still narrow, so the next
  //   narrow→wide edge stays inert and we don't re-force maximize on
  //   every pixel of resize.
  const wasNarrowRef = useRef<boolean | null>(null);
  const autoTriggeredRef = useRef(false);

  // Latest atom values for the observer callbacks to read without
  // re-subscribing on every render. Mirrored in an effect so the
  // ref write happens after render (react-hooks/refs lint rule).
  const stationModeRef = useRef(stationMode);
  const chatPanelMaximizedRef = useRef(chatPanelMaximized);
  const chatWidthRef = useRef(chatWidth);
  const chatVisibleRef = useRef(chatVisible);
  useEffect(() => {
    stationModeRef.current = stationMode;
    chatPanelMaximizedRef.current = chatPanelMaximized;
    chatWidthRef.current = chatWidth;
    chatVisibleRef.current = chatVisible;
  }, [stationMode, chatPanelMaximized, chatWidth, chatVisible]);

  // Last observed measurements. Cached so atom-driven re-evaluations
  // (chat width slider, chat visibility toggle, maximize toggle) can
  // run without waiting for the next ResizeObserver tick.
  const workbenchWidthRef = useRef<number>(0);
  const mainContentWidthRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) {
      wasNarrowRef.current = null;
      autoTriggeredRef.current = false;
      return;
    }

    let workbenchObserver: ResizeObserver | null = null;
    let mainObserver: ResizeObserver | null = null;
    let observedWorkbench: Element | null = null;
    let observedMain: Element | null = null;
    let lookupTimer: ReturnType<typeof setInterval> | null = null;

    const computeWorkbenchWidth = (): number => {
      // When maximized, AppLayout collapses the workbench surface to
      // `w-0` (so inline NSView webviews shrink with it), so its
      // measured width is ~0. Project from main-content minus the
      // docked chat slice instead — this models "what the workbench
      // width would be if chat were docked normally" and keeps the
      // narrow→wide edge stable across maximize toggles.
      if (chatPanelMaximizedRef.current) {
        const slice = chatVisibleRef.current ? chatWidthRef.current : 0;
        return Math.max(0, mainContentWidthRef.current - slice);
      }
      return workbenchWidthRef.current;
    };

    const evaluate = () => {
      const width = computeWorkbenchWidth();
      if (width <= 0) return;

      const isNarrow = width < NARROW_CHAT_FOCUS_BREAKPOINT_PX;
      const wasNarrow = wasNarrowRef.current;
      wasNarrowRef.current = isNarrow;
      const mode = stationModeRef.current;
      const maximized = chatPanelMaximizedRef.current;

      if (isNarrow && wasNarrow !== true) {
        if (maximized) return;
        // Ops Control hides the chat panel entirely (Kanban surface);
        // surprise-maximizing it on narrow would reveal a panel the
        // user explicitly switched away from. Leave it alone.
        if (mode === "ops-control" || mode === "journey") return;
        setChatPanelMaximized(true);
        autoTriggeredRef.current = true;
        return;
      }

      if (!isNarrow && wasNarrow === true) {
        if (!autoTriggeredRef.current) return;
        autoTriggeredRef.current = false;
        if (!maximized) return;
        setChatPanelMaximized(false);
      }
    };

    const attachObservers = (workbench: Element, main: Element) => {
      observedWorkbench = workbench;
      observedMain = main;

      workbenchObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          workbenchWidthRef.current = entry.contentRect.width;
        }
        evaluate();
      });
      mainObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          mainContentWidthRef.current = entry.contentRect.width;
        }
        evaluate();
      });

      workbenchObserver.observe(workbench);
      mainObserver.observe(main);

      workbenchWidthRef.current = workbench.getBoundingClientRect().width;
      mainContentWidthRef.current = main.getBoundingClientRect().width;
      evaluate();
    };

    const tryAttach = () => {
      const workbench = document.querySelector(WORKBENCH_SELECTOR);
      const main = document.querySelector(MAIN_CONTENT_SELECTOR);
      if (!workbench || !main) return false;
      attachObservers(workbench, main);
      return true;
    };

    if (!tryAttach()) {
      lookupTimer = setInterval(() => {
        if (tryAttach() && lookupTimer) {
          clearInterval(lookupTimer);
          lookupTimer = null;
        }
      }, SURFACE_LOOKUP_INTERVAL_MS);
    }

    return () => {
      if (lookupTimer) clearInterval(lookupTimer);
      if (workbenchObserver && observedWorkbench) {
        workbenchObserver.unobserve(observedWorkbench);
      }
      if (mainObserver && observedMain) {
        mainObserver.unobserve(observedMain);
      }
      workbenchObserver?.disconnect();
      mainObserver?.disconnect();
    };
  }, [enabled, setChatPanelMaximized]);

  // Atom-driven re-evaluations: chat width drag, chat visibility, or
  // maximize toggle changes shift the projected workbench width
  // without necessarily firing a ResizeObserver tick. Re-run the
  // same logic here so the breakpoint stays in sync.
  useEffect(() => {
    if (!enabled) return;
    if (workbenchWidthRef.current <= 0 && mainContentWidthRef.current <= 0) {
      return;
    }

    const width = chatPanelMaximized
      ? Math.max(0, mainContentWidthRef.current - (chatVisible ? chatWidth : 0))
      : workbenchWidthRef.current;

    if (width <= 0) return;

    const isNarrow = width < NARROW_CHAT_FOCUS_BREAKPOINT_PX;
    const wasNarrow = wasNarrowRef.current;
    wasNarrowRef.current = isNarrow;

    if (isNarrow && wasNarrow !== true) {
      if (chatPanelMaximized) return;
      if (stationMode === "ops-control" || stationMode === "journey") return;
      setChatPanelMaximized(true);
      autoTriggeredRef.current = true;
      return;
    }

    if (!isNarrow && wasNarrow === true) {
      if (!autoTriggeredRef.current) return;
      autoTriggeredRef.current = false;
      if (!chatPanelMaximized) return;
      setChatPanelMaximized(false);
    }
  }, [
    enabled,
    chatWidth,
    chatVisible,
    stationMode,
    chatPanelMaximized,
    setChatPanelMaximized,
  ]);

  // If the user manually un-maximizes while the workbench is still
  // narrow, drop the auto-flag so the eventual narrow→wide edge
  // doesn't try to restore a state they've already moved past.
  useEffect(() => {
    if (!enabled) return;
    if (chatPanelMaximized) return;
    if (wasNarrowRef.current !== true) return;
    autoTriggeredRef.current = false;
  }, [enabled, chatPanelMaximized]);
}
