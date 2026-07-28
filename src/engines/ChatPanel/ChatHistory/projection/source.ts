export interface ChatHistoryProjectionSource {
  activeSessionId: string | null;
  sourceIsOverride: boolean;
  sourceSessionId: string | null;
  sourceVersion: number;
}

export interface ResolvedChatHistoryProjectionSource {
  enabled: boolean;
  sourceVersion: number;
}

/**
 * Keep projection readiness paired with the atom route that supplied events.
 * A session-scoped history must not be gated by the unrelated global snapshot.
 */
export function resolveChatHistoryProjectionSource({
  activeSessionId,
  sourceIsOverride,
  sourceSessionId,
  sourceVersion,
}: ChatHistoryProjectionSource): ResolvedChatHistoryProjectionSource {
  return {
    enabled: Boolean(
      activeSessionId &&
      (sourceIsOverride || sourceSessionId === activeSessionId)
    ),
    sourceVersion,
  };
}
