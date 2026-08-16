import { Pin } from "lucide-react";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { BranchPrSnapshot } from "@src/store/git";
import type { Session } from "@src/store/session";
import { isSessionInProgress } from "@src/util/session/sessionInProgress";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import {
  getSessionListDisplayName,
  resolveSessionRowIcon,
} from "@src/util/session/sessionSidebarRow";
import {
  isSessionPendingAsking,
  resolveSessionStatusDotTone,
} from "@src/util/session/sessionStatusDot";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { renderSessionGitIndicator } from "./gitIndicator";
import { renderBreathingStatusDot, renderStatusDot } from "./statusIndicators";

export function separator(id: string, title = ""): NavigationMenuItem {
  return { id: `separator-${id}`, key: `separator-${id}`, label: title };
}

// Moved to @src/util/session/sessionStatusDot so non-sidebar surfaces (the
// channel session card) can share one derivation. Re-exported here because
// existing call sites import them from this module.
export {
  isSessionCompletedUnread,
  isSessionPendingAsking,
} from "@src/util/session/sessionStatusDot";

interface BuildSessionMenuItemParams {
  session: Session;
  untitledSession: string;
  visitedSessions: ReadonlySet<string>;
  /**
   * Blocked-on-user detail from lifecycle hooks (permission prompt /
   * question). Rendered as the row subtitle only while the session waits.
   */
  liveDetail?: string;
  /**
   * PR the session's branch belongs to, from the sidebar's per-repo snapshot
   * cache. Absent until the first fetch lands, or permanently for non-GitHub
   * remotes — the row falls back to a plain branch glyph either way.
   */
  pr?: BranchPrSnapshot;
}

export function buildSessionMenuItem({
  session,
  untitledSession,
  visitedSessions,
  liveDetail,
  pr,
}: BuildSessionMenuItemParams): NavigationMenuItem {
  const inProgress = isSessionInProgress(session.status, session);
  const displayName = getSessionListDisplayName(session, untitledSession);
  const timestampSrc =
    session.updated_at || session.updated_time || session.created_at;
  const pendingAsking = isSessionPendingAsking(session);
  const statusDotTone = resolveSessionStatusDotTone(session, visitedSessions);
  // A working row parks its dot in `workingIndicator` instead, so the trailing
  // slot may hold the git marker alone.
  const statusDot =
    inProgress && !pendingAsking ? null : renderStatusDot(statusDotTone);
  const gitIndicator = renderSessionGitIndicator(session, pr);
  // The section header used to be the ONLY at-rest pin affordance, so pinning
  // was invisible wherever that header does not render (cloud scope strips
  // every separator) — and since the list is already recency-sorted, pinning a
  // recent session moves it zero rows. Mark the row itself so pin state is
  // legible in every scope and every grouping mode.
  const pinIndicator = session.pinned ? (
    <Pin
      size={11}
      strokeWidth={2}
      className="shrink-0 text-text-3"
      aria-label="Pinned"
    />
  ) : null;

  return {
    id: session.session_id,
    key: session.session_id,
    label: displayName,
    searchText: getSessionSearchText(session, untitledSession),
    dataTestId: `sidebar-session-item-${session.session_id}`,
    pinned: session.pinned === true,
    icon: resolveSessionRowIcon(session),
    subtitle: liveDetail && pendingAsking ? liveDetail : undefined,
    workingIndicator:
      inProgress && !pendingAsking ? renderBreathingStatusDot() : undefined,
    trailingElement:
      pinIndicator || gitIndicator || statusDot ? (
        <span className="inline-flex items-center gap-1 leading-none">
          {pinIndicator}
          {gitIndicator}
          {statusDot}
        </span>
      ) : undefined,
    shortcut: formatRelativeTime(timestampSrc, "nano"),
    openContextMenuOnSelectedClick: true,
    dragPayload: {
      path: `session://${session.session_id}`,
      name: displayName,
      iconType: "session",
    },
  };
}
