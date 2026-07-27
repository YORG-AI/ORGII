import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useEffect } from "react";

import { useTodoSync } from "@src/engines/SessionCore/hooks/session/useTodoSync";
import { useFileReviewSync } from "@src/hooks/fileReview";
import { useSessionWorkspaceSync } from "@src/hooks/session/useSessionWorkspaceSync";
import {
  activeSessionIdAtom,
  claimPipelineSessionAtom,
} from "@src/store/session";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";

interface UseChatViewSessionLifecycleParams {
  sessionId: string;
  readOnly: boolean;
  secondary: boolean;
  isReadOnlySurface: boolean;
  isCursorIde: boolean;
}

/**
 * Owns the session-pipeline and workspace synchronization lifecycle for a
 * mounted ChatView. Keeping these side effects together prevents the render
 * orchestrator from reimplementing primary, secondary, and replay semantics.
 */
export function useChatViewSessionLifecycle({
  sessionId,
  readOnly,
  secondary,
  isReadOnlySurface,
  isCursorIde,
}: UseChatViewSessionLifecycleParams): void {
  const store = useStore();
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const claimPipelineSession = useSetAtom(claimPipelineSessionAtom);
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);

  useEffect(() => {
    if (readOnly) return;

    if (secondary) {
      claimPipelineSession(sessionId);
    } else {
      setActiveSessionId(sessionId);
    }

    if (!secondary) return;
    return () => {
      if (store.get(activeSessionIdAtom) === sessionId) {
        setActiveSessionId(null);
      }
    };
  }, [
    claimPipelineSession,
    readOnly,
    secondary,
    sessionId,
    setActiveSessionId,
    store,
  ]);

  useTodoSync(isReadOnlySurface ? undefined : sessionId);
  useFileReviewSync(sessionId, !isReadOnlySurface && !secondary);

  const isLiveStatus =
    runtimeStatus === "running" || runtimeStatus === "installing";
  useSessionWorkspaceSync({
    sessionId,
    enabled: !isReadOnlySurface && !secondary && !isCursorIde && isLiveStatus,
  });
}
