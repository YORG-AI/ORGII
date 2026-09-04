import type { ReactNode } from "react";

import { HugeiconsIcon, PinIcon, ViewOffIcon } from "@src/icons";
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

/**
 * Leading pin glyph for a pinned section header, matching the marker a pinned
 * session row carries (`buildSessionMenuItem` below). A pinned workspace group
 * is sorted to the top, but position alone reads as "alphabetically first" —
 * the glyph is what says the viewer put it there.
 */
export function renderPinnedSectionIndicator(): ReactNode {
  return (
    <HugeiconsIcon
      icon={PinIcon}
      data-icon="pin"
      size={10}
      strokeWidth={2}
      className="shrink-0 text-text-3"
      aria-label="Pinned"
    />
  );
}

/**
 * Leading glyph for a hidden section header — the mirror of the pin above.
 * A hidden group still renders (sorted last, collapsed), so without a marker
 * it is indistinguishable from one that merely sorts late; the glyph is what
 * makes "you hid this" legible, and readable at a glance as the state the
 * `…` menu's Unhide will clear.
 */
export function renderHiddenSectionIndicator(): ReactNode {
  return (
    <HugeiconsIcon
      icon={ViewOffIcon}
      data-icon="eye-off"
      size={10}
      strokeWidth={2}
      className="shrink-0 text-text-3"
      aria-label="Hidden"
    />
  );
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
  /** Controls the optional branch/worktree and pull-request status tag. */
  showBranchTag?: boolean;
  /** Pull request matched to this session's branch when tags are enabled. */
  pr?: BranchPrSnapshot;
}

export function buildSessionMenuItem({
  session,
  untitledSession,
  visitedSessions,
  liveDetail,
  showBranchTag = false,
  pr,
}: BuildSessionMenuItemParams): NavigationMenuItem {
  const inProgress = isSessionInProgress(session.status, session);
  const displayName = getSessionListDisplayName(session, untitledSession);
  const timestampSrc =
    session.updated_at || session.updated_time || session.created_at;
  const pendingAsking = isSessionPendingAsking(session);
  const statusDotTone = resolveSessionStatusDotTone(session, visitedSessions);
  const statusDot =
    inProgress && !pendingAsking
      ? renderBreathingStatusDot()
      : renderStatusDot(statusDotTone);
  const gitIndicator = showBranchTag
    ? renderSessionGitIndicator(session, pr)
    : null;
  // The section header used to be the ONLY at-rest pin affordance, so pinning
  // was invisible wherever that header does not render (cloud scope strips
  // every separator) — and since the list is already recency-sorted, pinning a
  // recent session moves it zero rows. Mark the row itself so pin state is
  // legible in every scope and every grouping mode.
  const pinIndicator = session.pinned ? (
    <HugeiconsIcon
      icon={PinIcon}
      data-icon="pin"
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
    iconBadge: statusDot,
    subtitle: liveDetail && pendingAsking ? liveDetail : undefined,
    trailingElement:
      pinIndicator || gitIndicator ? (
        <span className="inline-flex items-center gap-1 leading-none">
          {pinIndicator}
          {gitIndicator}
        </span>
      ) : undefined,
    shortcut: formatRelativeTime(timestampSrc, "nano"),
    openContextMenuOnSelectedClick: true,
    opensChatPanelTab: true,
    dragPayload: {
      path: `session://${session.session_id}`,
      name: displayName,
      iconType: "session",
    },
  };
}
