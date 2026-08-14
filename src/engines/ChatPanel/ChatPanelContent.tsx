import React, { Suspense } from "react";

import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

import SessionContentView from "./SessionContentView";
import type { SessionViewMode } from "./hooks/useSessionViewMode";

const BenchmarkPanel = React.lazy(() =>
  import("@src/features/BenchmarkPanel").then((module) => ({
    default: module.BenchmarkPanel,
  }))
);

interface ChatPanelContentProps {
  currentSessionId: string | null;
  emptyChatContent: React.ReactNode;
  handleRegisterSearchOpen: (handler: (() => void) | null) => void;
  onSessionContinuation: (continuation: SessionContinuation) => void;
  displayMode: ChatHistoryDisplayMode;
  paginationEnabled: boolean;
  position: "left" | "right";
  showBenchmarkSessionGroupContent: boolean;
  showPanelContent: boolean;
  showSessionContent: boolean;
  /** Non-GUI surface for the active session; mounted only while one is on. */
  alternateSessionView?: React.ReactNode;
  /** Which per-session view the header select currently resolves to. */
  sessionViewMode?: SessionViewMode;
  /** Height of the floating chat chrome the session view must clear. */
  chromeTopInset?: number;
}

/**
 * The shared "chat column": session transcript, the benchmark run-list (still
 * contentMode-driven), and the Launchpad / creator surfaces (`emptyChatContent`).
 * The workspace / organization / work-item / project / explore
 * surfaces are no longer rendered here — they are dedicated tab-typed renderers
 * dispatched by `UnifiedChatPanelTabContent`.
 */
export function ChatPanelContent({
  currentSessionId,
  emptyChatContent,
  handleRegisterSearchOpen,
  onSessionContinuation,
  displayMode,
  paginationEnabled,
  position,
  showBenchmarkSessionGroupContent,
  showPanelContent,
  showSessionContent,
  alternateSessionView,
  sessionViewMode = "gui",
  chromeTopInset = 0,
}: ChatPanelContentProps): React.ReactNode {
  const alternateActive = sessionViewMode !== "gui";
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!showPanelContent ? null : showBenchmarkSessionGroupContent ? (
        <Suspense fallback={null}>
          <BenchmarkPanel surface="runList" />
        </Suspense>
      ) : showSessionContent && currentSessionId ? (
        <>
          {/* Kept mounted while another view is showing: unmounting would drop
              the virtualized chat list's measurement cache and force a full
              re-measure of every turn on the way back. Hidden, not unmounted. */}
          <div
            className={`min-h-0 flex-1 flex-col ${
              alternateActive ? "hidden" : "flex"
            }`}
          >
            <SessionContentView
              sessionId={currentSessionId}
              onRegisterSearchOpen={handleRegisterSearchOpen}
              displayMode={displayMode}
              turnPaginationEnabled={paginationEnabled}
              position={position}
              chromeTopInset={chromeTopInset}
              onSessionContinuation={onSessionContinuation}
            />
          </div>
          {/* Mounted only while active. Each alternate view windows its own
              rows (CodeMirror for Raw, Virtuoso for Timeline / Changes), so
              none needs extra virtualization here — but none should be held
              in memory while the reader is back in the transcript. */}
          {alternateActive ? alternateSessionView : null}
        </>
      ) : (
        emptyChatContent
      )}
    </div>
  );
}
