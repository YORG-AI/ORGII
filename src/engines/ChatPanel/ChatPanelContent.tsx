import React, { Suspense } from "react";

import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

import ChatView from "./ChatView";

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
}

/**
 * The shared "chat column": session transcript, the benchmark run-list (still
 * contentMode-driven), and the Launchpad / creator surfaces (`emptyChatContent`).
 * The workspace / cloud-org / work-item / project / project-org / explore
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
}: ChatPanelContentProps): React.ReactNode {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!showPanelContent ? null : showBenchmarkSessionGroupContent ? (
        <Suspense fallback={null}>
          <BenchmarkPanel surface="runList" />
        </Suspense>
      ) : showSessionContent && currentSessionId ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatView
            sessionId={currentSessionId}
            onRegisterSearchOpen={handleRegisterSearchOpen}
            displayMode={displayMode}
            turnPaginationEnabled={paginationEnabled}
            position={position}
            onSessionContinuation={onSessionContinuation}
          />
        </div>
      ) : (
        emptyChatContent
      )}
    </div>
  );
}
