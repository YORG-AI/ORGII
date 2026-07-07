import { isUnifiedFailed } from "@src/types/session/session";

import { isSessionInProgress } from "./sessionInProgress";

export type SessionSidebarStatusTone =
  | "default"
  | "unread"
  | "asking"
  | "failed";

export function isSessionPendingAsking(status: string | undefined): boolean {
  return status === "waiting_for_user";
}

export function isSessionCompletedUnread(
  status: string | undefined,
  mergeStatus: string | undefined | null,
  visited: boolean
): boolean {
  if (!status || status !== "completed") return false;
  if (mergeStatus === "pending") return false;
  return !visited;
}

export function resolveSessionSidebarStatusTone(input: {
  status: string | undefined;
  mergeStatus?: string | null;
  visited: boolean;
}): SessionSidebarStatusTone {
  if (isSessionPendingAsking(input.status)) return "asking";
  if (isUnifiedFailed(input.status)) return "failed";
  if (
    isSessionCompletedUnread(input.status, input.mergeStatus, input.visited)
  ) {
    return "unread";
  }
  return "default";
}

export function shouldShowSessionSidebarBreathingIndicator(
  status: string | undefined
): boolean {
  return isSessionInProgress(status) && !isSessionPendingAsking(status);
}

export function shouldShowSessionSidebarTrailingDot(input: {
  status: string | undefined;
  tone: SessionSidebarStatusTone;
}): boolean {
  if (isSessionPendingAsking(input.status)) return true;
  if (isSessionInProgress(input.status)) return false;
  if (input.tone === "failed") return true;
  return true;
}
