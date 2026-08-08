import type { Session } from "@src/store/session/sessionAtom/types";
import { isTerminalStatus } from "@src/types/session/session";

export const SESSION_STATUS_DOT_COLOR = {
  default: "var(--color-fill-4)",
  working: "var(--color-primary-6)",
  unread: "var(--color-success-6)",
  asking: "var(--color-warning-6)",
  failed: "var(--color-danger-6)",
  archived: "var(--color-text-3)",
} as const;

export type SessionStatusDotTone = keyof typeof SESSION_STATUS_DOT_COLOR;

export function resolveSessionStatusDotColor(
  tone: SessionStatusDotTone
): string {
  return SESSION_STATUS_DOT_COLOR[tone];
}

export function isSessionPendingAsking(session: Session): boolean {
  return session.status === "waiting_for_user";
}

export function isSessionCompletedUnread(
  session: Session,
  visitedSessions: ReadonlySet<string>
): boolean {
  if (!isTerminalStatus(session.status)) return false;
  if (session.mergeStatus === "pending") return false;
  return !visitedSessions.has(session.session_id);
}

/**
 * The one derivation behind every session status dot. The sidebar row, the
 * spotlight hit and the channel session card all read the same session fields
 * in the same order, so a session can never present two different states in
 * two places. A working session is NOT a tone: it renders the breathing
 * marker instead, which is why callers check `isSessionInProgress` first.
 */
export function resolveSessionStatusDotTone(
  session: Session,
  visitedSessions: ReadonlySet<string>
): Extract<SessionStatusDotTone, "default" | "unread" | "asking"> {
  if (isSessionPendingAsking(session)) return "asking";
  if (isSessionCompletedUnread(session, visitedSessions)) return "unread";
  return "default";
}
