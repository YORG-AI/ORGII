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
 * Width sources (two of them, switched on direct manipulation):
 *
 * - While the user drags the chat divider, `[data-workbench-surface]`
 *   provides the live width because the CSS variable intentionally leads
 *   the persisted chat-width atom.
 *
 * - At rest or during programmatic pane motion, derive the projected target
 *   width from `[data-main-content].contentRect.width - chatWidth`. This
 *   keeps animated intermediate widths from looking like a genuine narrow
 *   viewport while still shrinking inline native webviews with the real
 *   flex track.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  chatPanelDraggingAtom,
  chatPanelMaximizedAtom,
  chatVisibleAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";

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
 * ResizeObserver can only attach to existing elements. The AppShell can mount
 * before the WorkStation tree, so a short-lived MutationObserver waits for
 * those two selectors without a recurring timer.
 */

interface UseNarrowChatFocusOptions {
  /** Only run while a WorkStation / Agent Station route is active. */
  enabled: boolean;
}

interface ResolveWorkbenchEvaluationWidthOptions {
  chatPanelDragging: boolean;
  chatPanelMaximized: boolean;
  chatVisible: boolean;
  chatWidth: number;
  mainContentWidth: number;
  measuredWorkbenchWidth: number;
}

/**
 * Use the target normal-flow width for programmatic pane motion so the
 * intermediate animation frames do not look like a genuine narrow layout.
 * During direct manipulation, keep reading the measured workbench because
 * the live CSS width intentionally leads the persisted chat-width atom.
 */
export function resolveWorkbenchEvaluationWidth({
  chatPanelDragging,
  chatPanelMaximized,
  chatVisible,
  chatWidth,
  mainContentWidth,
  measuredWorkbenchWidth,
}: ResolveWorkbenchEvaluationWidthOptions): number {
  if (chatPanelDragging && !chatPanelMaximized) {
    return measuredWorkbenchWidth;
  }

  const chatSlice = chatVisible ? chatWidth : 0;
  return Math.max(0, mainContentWidth - chatSlice);
}

export function useNarrowChatFocus({
  enabled,
}: UseNarrowChatFocusOptions): void {
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const chatPanelDragging = useAtomValue(chatPanelDraggingAtom);
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
  const chatPanelMaximizedRef = useRef(chatPanelMaximized);
  const chatPanelDraggingRef = useRef(chatPanelDragging);
  const chatWidthRef = useRef(chatWidth);
  const chatVisibleRef = useRef(chatVisible);
  useEffect(() => {
    chatPanelMaximizedRef.current = chatPanelMaximized;
    chatPanelDraggingRef.current = chatPanelDragging;
    chatWidthRef.current = chatWidth;
    chatVisibleRef.current = chatVisible;
  }, [chatPanelDragging, chatPanelMaximized, chatWidth, chatVisible]);

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
    let lookupObserver: MutationObserver | null = null;

    const computeWorkbenchWidth = (): number => {
      return resolveWorkbenchEvaluationWidth({
        chatPanelDragging: chatPanelDraggingRef.current,
        chatPanelMaximized: chatPanelMaximizedRef.current,
        chatVisible: chatVisibleRef.current,
        chatWidth: chatWidthRef.current,
        mainContentWidth: mainContentWidthRef.current,
        measuredWorkbenchWidth: workbenchWidthRef.current,
      });
    };

    const evaluate = () => {
      const width = computeWorkbenchWidth();
      if (width <= 0) return;

      const isNarrow = width < NARROW_CHAT_FOCUS_BREAKPOINT_PX;
      const wasNarrow = wasNarrowRef.current;
      wasNarrowRef.current = isNarrow;
      const maximized = chatPanelMaximizedRef.current;

      if (isNarrow && wasNarrow !== true) {
        if (maximized) return;
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
      lookupObserver = new MutationObserver(() => {
        if (tryAttach()) {
          lookupObserver?.disconnect();
          lookupObserver = null;
        }
      });
      lookupObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    return () => {
      lookupObserver?.disconnect();
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

    const width = resolveWorkbenchEvaluationWidth({
      chatPanelDragging,
      chatPanelMaximized,
      chatVisible,
      chatWidth,
      mainContentWidth: mainContentWidthRef.current,
      measuredWorkbenchWidth: workbenchWidthRef.current,
    });

    if (width <= 0) return;

    const isNarrow = width < NARROW_CHAT_FOCUS_BREAKPOINT_PX;
    const wasNarrow = wasNarrowRef.current;
    wasNarrowRef.current = isNarrow;

    if (isNarrow && wasNarrow !== true) {
      if (chatPanelMaximized) return;
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
    chatPanelDragging,
    chatWidth,
    chatVisible,
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
