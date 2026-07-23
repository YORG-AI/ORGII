/**
 * useGanttScroll Hook
 *
 * Synchronizes scrolling between sidebar, header, and timeline body.
 */
import { RefObject, useCallback } from "react";

export interface UseGanttScrollOptions {
  timelineBodyRef: RefObject<HTMLDivElement | null>;
  sidebarContentRef: RefObject<HTMLDivElement | null>;
  headerScrollRef?: RefObject<HTMLDivElement | null>;
}

export function useGanttScroll({
  timelineBodyRef,
  sidebarContentRef,
  headerScrollRef,
}: UseGanttScrollOptions) {
  const handleTimelineScroll = useCallback(() => {
    if (timelineBodyRef.current) {
      // Sync vertical scroll with sidebar
      if (sidebarContentRef.current) {
        const nextScrollTop = timelineBodyRef.current.scrollTop;
        if (sidebarContentRef.current.scrollTop !== nextScrollTop) {
          sidebarContentRef.current.scrollTop = nextScrollTop;
        }
      }
      // Sync horizontal scroll with header
      if (headerScrollRef?.current) {
        const nextScrollLeft = timelineBodyRef.current.scrollLeft;
        if (headerScrollRef.current.scrollLeft !== nextScrollLeft) {
          headerScrollRef.current.scrollLeft = nextScrollLeft;
        }
      }
    }
  }, [timelineBodyRef, sidebarContentRef, headerScrollRef]);

  const handleSidebarScroll = useCallback(() => {
    if (!sidebarContentRef.current || !timelineBodyRef.current) return;

    const nextScrollTop = sidebarContentRef.current.scrollTop;
    if (timelineBodyRef.current.scrollTop !== nextScrollTop) {
      timelineBodyRef.current.scrollTop = nextScrollTop;
    }
  }, [sidebarContentRef, timelineBodyRef]);

  return { handleTimelineScroll, handleSidebarScroll };
}
