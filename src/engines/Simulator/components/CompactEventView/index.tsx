/**
 * CompactEventView
 *
 * Single-event renderer for subagent grid cells. Delegates ALL rendering
 * to ActivityChatItem — the same component the main chat panel uses.
 *
 * Previously this component had its own file/shell/diff renderers that
 * duplicated CodePanel's logic. Now the rendering pipeline is unified:
 * SubagentEventPane routes CODE_EDITOR events to CodePanel, and everything
 * else lands here and goes straight to ActivityChatItem.
 */
import React, { Suspense, memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import ActivityChatItem from "@src/engines/ChatPanel/ChatHistory/ActivityRouter";
import type { SessionEvent } from "@src/engines/SessionCore";

// ── Component ──

interface CompactEventViewProps {
  event: SessionEvent | null;
  autoScroll?: boolean;
  isPlaying?: boolean;
  playbackSpeed?: number;
}

const CompactEventViewComponent: React.FC<CompactEventViewProps> = ({
  event,
  autoScroll = false,
  isPlaying = false,
  playbackSpeed = 1,
}) => {
  const { t } = useTranslation("sessions");
  const contentRef = useRef<HTMLDivElement>(null);
  const eventId = event?.id;

  // Reset scroll when event changes
  useEffect(() => {
    if (autoScroll && eventId) {
      contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [eventId, autoScroll]);

  // Continuous auto-scroll during playback
  useEffect(() => {
    if (!autoScroll || !isPlaying || !contentRef.current) return;
    const scrollSpeed = 1.5 * playbackSpeed;
    let animationId: number;
    let lastTime = 0;
    const tick = (now: number) => {
      if (!lastTime) lastTime = now;
      if (now - lastTime >= 16) {
        const el = contentRef.current;
        if (el && el.scrollTop < el.scrollHeight - el.clientHeight - 1) {
          el.scrollTop += scrollSpeed;
        }
        lastTime = now;
      }
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [autoScroll, isPlaying, playbackSpeed]);

  if (!event) {
    return (
      <div className="flex h-full items-center justify-center text-text-4">
        <span className="text-xs">{t("simulator.awaitingActivity")}</span>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <div
        ref={contentRef}
        className="h-full overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="allow-select-deep min-h-0 flex-1 px-2 pb-4 pt-2">
          <Suspense
            fallback={<div className="h-8 animate-pulse rounded bg-fill-2" />}
          >
            <ActivityChatItem
              event={event}
              itemIndex={0}
              isStreaming={isPlaying}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
};

export const CompactEventView = memo(CompactEventViewComponent);
CompactEventView.displayName = "CompactEventView";
