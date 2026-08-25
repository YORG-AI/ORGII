/**
 * OutputContent Component
 *
 * Displays output from various channels (Tasks, Git, Build, etc.)
 * Similar to VS Code's Output panel.
 * Uses TerminalOutput component for consistent ANSI rendering.
 * Supports Cmd/Ctrl+F search with match highlighting & navigation.
 * Note: Channel selector and controls are now in the bottom panel header.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TerminalOutput } from "@src/components/TerminalDisplay/TerminalOutput";
import { useScrollToBottom } from "@src/hooks/ui/effects";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { OutputSearchPanel } from "./OutputSearchPanel";
import "./index.scss";
import type { OutputChannel } from "./types";
import { useOutputSearch } from "./useOutputSearch";

// ============================================
// Types
// ============================================

export interface OutputContentProps {
  /** List of all output channels */
  channels: OutputChannel[];
  /** Currently active channel ID */
  activeChannelId: string | null;
  /** Custom class name */
  className?: string;
}

// ============================================
// Main Component
// ============================================

export const OutputContent: React.FC<OutputContentProps> = memo(
  ({ channels, activeChannelId, className = "" }) => {
    const { t } = useTranslation();
    const contentRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [searchOpen, setSearchOpen] = useState(false);

    // Search hook — operates on the scrollable content container
    const { searchState, findNext, findPrevious, clearSearch } =
      useOutputSearch(contentRef);

    // Get active channel
    const activeChannel = channels.find((ch) => ch.id === activeChannelId);

    // Auto-scroll to bottom when content changes (VS Code-style)
    // Only auto-scroll when search is NOT active (user may be browsing matches)
    useScrollToBottom({
      containerRef: contentRef,
      dependencies: [activeChannel?.content, activeChannelId],
      forceScroll: !searchOpen,
    });

    // Clear search when switching channels
    useEffect(() => {
      clearSearch();
    }, [activeChannelId, clearSearch]);

    // Cmd/Ctrl+F to open search
    useEffect(() => {
      const container = panelRef.current;
      if (!container) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        const isMod = event.metaKey || event.ctrlKey;
        if (isMod && event.key === "f") {
          event.preventDefault();
          event.stopPropagation();
          setSearchOpen(true);
        }
      };

      container.addEventListener("keydown", handleKeyDown);
      return () => container.removeEventListener("keydown", handleKeyDown);
    }, []);

    const handleCloseSearch = useCallback(() => {
      setSearchOpen(false);
    }, []);

    // No channels state
    if (channels.length === 0) {
      return (
        <div className={`output-panel ${className}`}>
          <Placeholder
            variant="empty"
            title={t("placeholders.noOutputChannels")}
          />
        </div>
      );
    }

    return (
      <div ref={panelRef} className={`output-panel ${className}`} tabIndex={-1}>
        {/* Search bar */}
        <OutputSearchPanel
          isOpen={searchOpen}
          onClose={handleCloseSearch}
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClearSearch={clearSearch}
          searchState={searchState}
        />

        {/* Content - single scrollable container like Terminal panel */}
        <div ref={contentRef} className="output-panel__content">
          {activeChannel ? (
            activeChannel.content.length === 0 ? (
              <Placeholder
                variant="empty"
                title={t("placeholders.noOutputYet")}
              />
            ) : (
              <TerminalOutput
                output={activeChannel.content}
                processAnsi={activeChannel.processAnsi !== false}
                maxHeight={undefined}
                showLoading={false}
                className="output-panel__terminal-output"
              />
            )
          ) : (
            <Placeholder
              variant="empty"
              title={t("placeholders.noOutputChannelActive")}
            />
          )}
        </div>
      </div>
    );
  }
);

OutputContent.displayName = "OutputContent";

export default OutputContent;
