/**
 * useWorkspaceEvents Hook
 *
 * Listens for the Tauri workspace-open event and handles navigation.
 */
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { isTauriDesktop } from "@src/util/platform/tauri";

/** Navigate to the session referenced by an `open-workspace` event. */
export function useWorkspaceEvents(): void {
  const { openSession } = useSessionView();
  const isTauri = isTauriDesktop();

  const openSessionRef = useRef(openSession);
  useEffect(() => {
    openSessionRef.current = openSession;
  }, [openSession]);

  useEffect(() => {
    if (!isTauri) return;

    let cancelled = false;
    let unlistenWorkspaceFn: (() => void) | null = null;

    listen("open-workspace", async (event) => {
      if (cancelled) return;
      const { sessionId, projectId } = event.payload as {
        sessionId: string;
        projectId: string;
        buildType?: string;
      };

      if (sessionId && projectId) {
        openSessionRef.current(sessionId);
      }
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
      } else {
        unlistenWorkspaceFn = unlisten;
      }
    });

    return () => {
      cancelled = true;
      unlistenWorkspaceFn?.();
    };
  }, [isTauri]);
}
