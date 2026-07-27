/**
 * Cross-surface "reveal this session in the sidebar" request bookkeeping
 * for `WorkstationSidebarConnector` (`index.tsx`). Tracks which reveal
 * request id has already been acted on (so it can be cleared once the
 * requested session becomes active) and the set of session ids that should
 * render revealed even though the sidebar hasn't scrolled/expanded to them
 * yet.
 */
import React, { useEffect, useMemo } from "react";

import type { SessionSidebarRevealRequest } from "@src/store/ui/sidebarAtom";

interface UseWorkstationSidebarRevealRequestStateParams {
  sessionSidebarRevealRequest: SessionSidebarRevealRequest | null;
  activeSessionId: string;
  clearSessionSidebarReveal: (requestId: number) => void;
}

export function useWorkstationSidebarRevealRequestState({
  sessionSidebarRevealRequest,
  activeSessionId,
  clearSessionSidebarReveal,
}: UseWorkstationSidebarRevealRequestStateParams) {
  const activatedRevealRequestIdRef = React.useRef<number | null>(null);
  const activeSessionSidebarRevealRequest =
    sessionSidebarRevealRequest?.sessionId === activeSessionId
      ? sessionSidebarRevealRequest
      : null;
  useEffect(() => {
    if (!sessionSidebarRevealRequest) {
      activatedRevealRequestIdRef.current = null;
      return;
    }
    if (sessionSidebarRevealRequest.sessionId === activeSessionId) {
      activatedRevealRequestIdRef.current =
        sessionSidebarRevealRequest.requestId;
      return;
    }
    if (
      activatedRevealRequestIdRef.current ===
      sessionSidebarRevealRequest.requestId
    ) {
      clearSessionSidebarReveal(sessionSidebarRevealRequest.requestId);
      activatedRevealRequestIdRef.current = null;
    }
  }, [activeSessionId, clearSessionSidebarReveal, sessionSidebarRevealRequest]);
  const revealedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (activeSessionSidebarRevealRequest?.sessionId) {
      ids.add(activeSessionSidebarRevealRequest.sessionId);
    }
    if (activeSessionSidebarRevealRequest?.parentSessionId) {
      ids.add(activeSessionSidebarRevealRequest.parentSessionId);
    }
    return ids;
  }, [activeSessionSidebarRevealRequest]);

  return { activeSessionSidebarRevealRequest, revealedSessionIds };
}
