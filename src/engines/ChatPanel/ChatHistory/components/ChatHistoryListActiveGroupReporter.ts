/**
 * useChatHistoryListActiveGroupReporter
 *
 * Scroll-driven "which turn group is active" reporter for `ChatHistoryList`.
 * Coalesces recomputation to one per animation frame and toggles the
 * in-list group header's visibility when a separate pinned header is
 * rendered above it. Extracted from `ChatHistoryList.tsx` to keep that
 * file under the 600-line limit.
 */
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef } from "react";

import {
  resolveActiveGroupPinState,
  resolveVisibleGroupIndices,
} from "./ChatHistoryListLayout";

export function useChatHistoryListActiveGroupReporter(params: {
  staticScrollerRef?: MutableRefObject<HTMLDivElement | null>;
  virtualScrollerRef: MutableRefObject<HTMLDivElement | null>;
  useStaticRendering: boolean;
  virtualListDataKey: string;
  hideActiveGroupHeader: boolean;
  onActiveGroupIndexChange?: (
    groupIndex: number,
    pinned: boolean,
    visibleGroupIndices: number[]
  ) => void;
}): {
  scheduleReportActiveGroupIndex: (scrollRoot: HTMLDivElement) => void;
} {
  const {
    staticScrollerRef,
    virtualScrollerRef,
    useStaticRendering,
    virtualListDataKey,
    hideActiveGroupHeader,
    onActiveGroupIndexChange,
  } = params;

  const lastReportedGroupStateRef = useRef<{
    groupIndex: number;
    pinned: boolean;
    visibleGroupIndices: number[];
  } | null>(null);
  const reportActiveGroupIndex = useCallback(
    (scrollRoot: HTMLDivElement) => {
      const groupElements = Array.from(
        scrollRoot.querySelectorAll<HTMLElement>("[data-chat-group-index]")
      );
      if (!onActiveGroupIndexChange && !hideActiveGroupHeader) {
        for (const groupElement of groupElements) {
          const headerElement = groupElement.querySelector<HTMLElement>(
            "[data-chat-group-header]"
          );
          if (!headerElement) continue;
          headerElement.style.visibility = "";
          headerElement.removeAttribute("aria-hidden");
        }
        return;
      }

      const rootRect = scrollRoot.getBoundingClientRect();
      const groupMetrics = groupElements.flatMap((groupElement) => {
        const groupIndex = Number(groupElement.dataset.chatGroupIndex);
        if (!Number.isFinite(groupIndex)) return [];
        const groupRect = groupElement.getBoundingClientRect();
        return [
          {
            groupIndex,
            top: groupRect.top - rootRect.top,
            bottom: groupRect.bottom - rootRect.top,
          },
        ];
      });
      const pinState = resolveActiveGroupPinState(groupMetrics);
      const visibleGroupIndices = resolveVisibleGroupIndices(
        groupMetrics,
        rootRect.height
      );
      for (const groupElement of groupElements) {
        const groupIndex = Number(groupElement.dataset.chatGroupIndex);
        const headerElement = groupElement.querySelector<HTMLElement>(
          "[data-chat-group-header]"
        );
        if (!headerElement) continue;
        const hideOriginal =
          hideActiveGroupHeader &&
          pinState.pinned &&
          groupIndex === pinState.groupIndex;
        headerElement.style.visibility = hideOriginal ? "hidden" : "";
        headerElement.toggleAttribute("aria-hidden", hideOriginal);
      }
      const previousState = lastReportedGroupStateRef.current;
      const visibleGroupsChanged =
        previousState?.visibleGroupIndices.length !==
          visibleGroupIndices.length ||
        !previousState?.visibleGroupIndices.every(
          (groupIndex, index) => groupIndex === visibleGroupIndices[index]
        );
      if (
        previousState?.groupIndex !== pinState.groupIndex ||
        previousState?.pinned !== pinState.pinned ||
        visibleGroupsChanged
      ) {
        lastReportedGroupStateRef.current = {
          groupIndex: pinState.groupIndex,
          pinned: pinState.pinned,
          visibleGroupIndices,
        };
        onActiveGroupIndexChange?.(
          pinState.groupIndex,
          pinState.pinned,
          visibleGroupIndices
        );
      }
    },
    [hideActiveGroupHeader, onActiveGroupIndexChange]
  );

  // Coalesce scroll-driven active-group recomputes to one per animation
  // frame. `reportActiveGroupIndex` runs a querySelectorAll, a
  // getBoundingClientRect per group, and header style writes; calling it
  // synchronously on every scroll event (60–120Hz during momentum) forced a
  // read→write→read layout thrash on the scroll tick. Batching into a rAF
  // keeps those reads/writes off the scroll handler.
  const activeGroupFrameRef = useRef<number | null>(null);
  const scheduleReportActiveGroupIndex = useCallback(
    (scrollRoot: HTMLDivElement) => {
      if (activeGroupFrameRef.current !== null) return;
      activeGroupFrameRef.current = window.requestAnimationFrame(() => {
        activeGroupFrameRef.current = null;
        reportActiveGroupIndex(scrollRoot);
      });
    },
    [reportActiveGroupIndex]
  );
  useEffect(
    () => () => {
      if (activeGroupFrameRef.current !== null) {
        window.cancelAnimationFrame(activeGroupFrameRef.current);
        activeGroupFrameRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    lastReportedGroupStateRef.current = null;
    const frameId = window.requestAnimationFrame(() => {
      const scrollRoot = useStaticRendering
        ? staticScrollerRef?.current
        : virtualScrollerRef.current;
      if (scrollRoot) reportActiveGroupIndex(scrollRoot);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    reportActiveGroupIndex,
    staticScrollerRef,
    useStaticRendering,
    virtualListDataKey,
    virtualScrollerRef,
  ]);

  return { scheduleReportActiveGroupIndex };
}
