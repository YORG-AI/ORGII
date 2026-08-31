import type { MobileSessionRow } from "../connection/types";

export function resolveMobileSessionTitle(
  sessions: readonly MobileSessionRow[],
  sessionId: string
): string {
  const name = sessions
    .find((session) => session.id === sessionId)
    ?.name.trim();
  return name || sessionId;
}
