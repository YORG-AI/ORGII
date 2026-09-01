/**
 * ThreadSelector Component
 *
 * Displays thread selection buttons for execution stage events.
 * Designed to appear INLINE within the execution stage block.
 *
 * Features:
 * - Compact pill-style design matching ChatPanel aesthetic
 * - Status indicators (running/completed)
 * - Event count badges
 * - Click to navigate to thread's events
 * - Smooth transitions
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import { formatThreadDisplayName } from "./config";
import type { ExecutionThread, ThreadSelectorProps } from "./types";

/** Status indicator for thread state */
const ThreadStatusDot: React.FC<{
  thread: ExecutionThread;
  isSelected: boolean;
}> = memo(({ thread, isSelected }) => {
  const { t } = useTranslation();
  if (thread.isRunning) {
    return (
      <span
        className={`relative flex h-1.5 w-1.5 ${isSelected ? "ml-1" : "ml-1.5"}`}
        title={t("status.running")}
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-500" />
      </span>
    );
  }
  if (thread.isCompleted) {
    return (
      <span
        className={`ml-1 text-[10px] ${isSelected ? "text-white/80" : "text-green-500"}`}
        title={t("status.completed")}
      >
        ✓
      </span>
    );
  }
  return null;
});
ThreadStatusDot.displayName = "ThreadStatusDot";

/** Event count badge - compact style */
const EventCountBadge: React.FC<{ count: number; isSelected: boolean }> = memo(
  ({ count, isSelected }) => {
    return (
      <span
        className={`ml-1 rounded px-1 py-px text-[10px] tabular-nums ${
          isSelected ? "bg-white/20 text-white" : "bg-fill-2 text-text-3"
        }`}
      >
        {count}
      </span>
    );
  }
);
EventCountBadge.displayName = "EventCountBadge";

const ThreadSelector: React.FC<ThreadSelectorProps> = memo(
  ({
    threads,
    selectedThreadId,
    onSelectThread,
    showAllOption = true,
    onNavigateToThread,
  }) => {
    const { t } = useTranslation("sessions");
    if (threads.length <= 1) {
      return null;
    }

    const selectedThread = threads.find(
      (thread) => thread.threadId === selectedThreadId
    );
    const selectedDisplayName = selectedThread
      ? selectedThread.displayName ||
        formatThreadDisplayName(selectedThread.threadId)
      : null;

    // Calculate stats
    const completedCount = threads.filter(
      (thread) => thread.isCompleted
    ).length;
    const totalCount = threads.length;

    // Handle thread click - select and optionally navigate
    const handleThreadClick = (threadId: string | null) => {
      onSelectThread(threadId);
      // Navigate to the thread's first event if handler provided
      if (threadId && onNavigateToThread) {
        onNavigateToThread(threadId);
      }
    };

    return (
      <div className="thread-selector mx-3 my-2 rounded-lg border border-border-1 bg-bg-2/50 p-2.5 transition-all duration-200">
        {/* Compact header */}
        <div className="mb-2 flex items-center justify-between px-0.5">
          <span className="text-[11px] font-medium text-text-2">
            {t("chat.executionThreads")}
          </span>
          <span className="text-[10px] tabular-nums text-text-3">
            {completedCount}/{totalCount}
          </span>
        </div>

        {/* Thread pills - horizontal scroll if needed */}
        <div className="flex flex-wrap gap-1.5">
          {/* All button */}
          {showAllOption && threads.length > 1 && (
            <button
              type="button"
              onClick={() => handleThreadClick(null)}
              className={`flex items-center rounded-md px-2 py-1 text-[11px] transition-all duration-150 ${
                selectedThreadId === null
                  ? "bg-primary-6 text-white"
                  : "bg-fill-1 text-text-2 hover:bg-fill-2"
              }`}
            >
              {t("chat.allThreads")}
              <span
                className={`ml-1 rounded px-1 py-px text-[10px] tabular-nums ${
                  selectedThreadId === null
                    ? "bg-white/20 text-white"
                    : "bg-fill-2 text-text-3"
                }`}
              >
                {totalCount}
              </span>
            </button>
          )}

          {/* Thread buttons */}
          {threads.map((thread) => {
            const isSelected = selectedThreadId === thread.threadId;
            const displayName =
              thread.displayName || formatThreadDisplayName(thread.threadId);

            return (
              <button
                key={thread.threadId}
                type="button"
                onClick={() => handleThreadClick(thread.threadId)}
                className={`group flex items-center rounded-md px-2 py-1 text-[11px] transition-all duration-150 ${
                  isSelected
                    ? "bg-primary-6 text-white"
                    : thread.isRunning
                      ? "bg-yellow-500/10 text-text-2 hover:bg-yellow-500/20"
                      : thread.isCompleted
                        ? "bg-green-500/10 text-text-2 hover:bg-green-500/20"
                        : "bg-fill-1 text-text-2 hover:bg-fill-2"
                }`}
              >
                {displayName}
                <ThreadStatusDot thread={thread} isSelected={isSelected} />
                <EventCountBadge
                  count={thread.eventCount}
                  isSelected={isSelected}
                />
              </button>
            );
          })}
        </div>

        {/* Selected thread indicator - compact */}
        {selectedThreadId && selectedDisplayName && selectedThread && (
          <div className="mt-2 flex items-center justify-between rounded-md bg-fill-1 px-2 py-1.5 transition-all duration-200">
            <div className="flex items-center gap-1.5 text-[11px]">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={12}
                className="text-primary-6"
              />
              <span className="font-medium text-text-1">
                {selectedDisplayName}
              </span>
              <ThreadStatusDot thread={selectedThread} isSelected={false} />
              <span className="text-text-3">
                · {t("chat.eventCount", { count: selectedThread.eventCount })}
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleThreadClick(null)}
              className="text-[10px] text-text-3 transition-colors hover:text-primary-6"
            >
              {t("chat.showAll")}
            </button>
          </div>
        )}
      </div>
    );
  }
);

ThreadSelector.displayName = "ThreadSelector";

export default ThreadSelector;
