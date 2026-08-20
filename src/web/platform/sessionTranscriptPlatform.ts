import { useEffect, useRef } from "react";

import { useSessionTranscriptRuntime } from "@src/engines/ChatPanel/SessionTranscriptRuntimeContext";
import type { SessionTranscriptPlatformState } from "@src/engines/ChatPanel/runtime/sessionTranscriptPlatform.types";

/** Browser adapter: all state and actions come from the Cloud-backed surface. */
export function useSessionTranscriptPlatform(
  _sessionId: string | null
): SessionTranscriptPlatformState {
  const runtime = useSessionTranscriptRuntime();
  if (!runtime) {
    throw new Error(
      "Web Session transcript must be rendered inside SessionTranscriptRuntimeProvider"
    );
  }

  const isAgentWorkingRef = useRef(runtime.isAgentWorking);
  useEffect(() => {
    isAgentWorkingRef.current = runtime.isAgentWorking;
  }, [runtime.isAgentWorking]);

  return {
    session: undefined,
    cursorIdeTurnSummaries: [],
    isCursorIde: false,
    isAgentWorking: runtime.isAgentWorking,
    isAgentWorkingRef,
    isExploring: runtime.isExploring ?? false,
    loadStatus: runtime.loadStatus,
    loadError: runtime.loadError,
    isPendingCancel: false,
    isRolledBack: false,
    isHydrating: false,
    onReload: runtime.onReload,
    onReplyQuestion: runtime.onReplyQuestion ?? (() => undefined),
    onIgnoreQuestion: runtime.onIgnoreQuestion ?? (() => undefined),
    capabilities: {
      canvasInline: runtime.capabilities?.canvasInline !== false,
      turnMetadata: runtime.capabilities?.turnMetadata !== false,
    },
  };
}
