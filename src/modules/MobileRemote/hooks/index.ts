/** Thin hooks — delegate to MobileRemoteProviders context. */
import { useMobileRemote } from "../app";

export function useSessionList() {
  const { sessions, refreshSessions, connection } = useMobileRemote();
  return { sessions, refreshSessions, connection };
}

export function useSessionTranscript(_sessionId: string | null) {
  const { transcriptItems } = useMobileRemote();
  return { items: transcriptItems };
}

export function useInteractionQueue() {
  const {
    activePermission,
    permissionQueueDepth,
    respondPermission,
    dismissPermissionHead,
  } = useMobileRemote();
  return {
    activePermission,
    queueDepth: permissionQueueDepth,
    respondPermission,
    dismissPermissionHead,
  };
}

export function useMobileSend(sessionId: string | null) {
  const { sendMessage, connection } = useMobileRemote();
  return {
    send: (content: string) => {
      if (!sessionId) return Promise.resolve();
      return sendMessage(sessionId, content);
    },
    tier: connection.tier,
    demoMode: connection.demoMode,
  };
}
