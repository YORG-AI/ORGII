import { useCallback } from "react";

import { MAX_MUTED_NOTIFICATION_SESSION_IDS } from "@src/config/settingsSchema/registry/notifications";
import { useSetting } from "@src/store/settings";

export function updateMutedSessionIds(
  current: readonly string[],
  sessionId: string,
  muted: boolean
): string[] {
  const withoutSession = current.filter((id) => id !== sessionId);
  if (!muted) return withoutSession;
  return [sessionId, ...withoutSession].slice(
    0,
    MAX_MUTED_NOTIFICATION_SESSION_IDS
  );
}

export function useSessionNotificationMute(sessionId: string | null): {
  isMuted: boolean;
  setMuted: (muted: boolean) => void;
} {
  const [mutedSessionIds, setMutedSessionIds] = useSetting(
    "notifications.mutedSessionIds"
  );
  const isMuted = sessionId ? mutedSessionIds.includes(sessionId) : false;

  const setMuted = useCallback(
    (muted: boolean) => {
      if (!sessionId) return;
      setMutedSessionIds(
        updateMutedSessionIds(mutedSessionIds, sessionId, muted)
      );
    },
    [mutedSessionIds, sessionId, setMutedSessionIds]
  );

  return { isMuted, setMuted };
}
