/**
 * useChatViewPipelineClaim
 *
 * Writes `activeSessionIdAtom` (or claims the pipeline, for secondary
 * surfaces) so `SessionSyncProvider` loads this session's data into the
 * global event store. Secondary surfaces additionally null the pipeline
 * atom on unmount when they were the last claimant, so that event
 * streaming does not outlive the embedding. Passive `readOnly` replay
 * surfaces skip the claim entirely.
 */
import { useSetAtom, useStore } from "jotai";
import { useEffect } from "react";

import {
  activeSessionIdAtom,
  claimPipelineSessionAtom,
} from "@src/store/session";

export function useChatViewPipelineClaim({
  sessionId,
  readOnly,
  secondary,
}: {
  sessionId: string;
  readOnly: boolean;
  secondary: boolean;
}) {
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const claimPipelineSession = useSetAtom(claimPipelineSessionAtom);
  const store = useStore();

  useEffect(() => {
    // Imported history is immutable at its source, but it still owns the
    // event pipeline while visible. Only explicit passive replay skips the
    // claim. Secondary surfaces also need the canonical clear/loading
    // transition because they do not navigate through jumpToSessionAtom.
    if (readOnly) return;
    if (secondary) {
      claimPipelineSession(sessionId);
    } else {
      setActiveSessionId(sessionId);
    }

    // Secondary surfaces (e.g. kanban detail panel) must release the
    // pipeline when the embedding closes, otherwise event streaming
    // would keep running for a session no surface is showing. We
    // only release if the pipeline is still pointing at this view's
    // session — another surface may already have taken over.
    // Primary (WorkStation) surfaces don't release on unmount: the
    // pipeline atom is owned by WorkStation memory, which the bridge
    // re-asserts whenever WorkStation is active.
    if (!secondary) return;
    return () => {
      const current = store.get(activeSessionIdAtom);
      if (current === sessionId) {
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
}
