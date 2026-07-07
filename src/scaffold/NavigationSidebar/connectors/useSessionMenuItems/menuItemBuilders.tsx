import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import {
  getSessionListDisplayName,
  resolveSessionRowIcon,
} from "@src/util/session/sessionSidebarRow";
import {
  resolveSessionSidebarStatusTone,
  shouldShowSessionSidebarBreathingIndicator,
  shouldShowSessionSidebarTrailingDot,
} from "@src/util/session/sessionSidebarStatusTone";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { renderBreathingStatusDot, renderStatusDot } from "./statusIndicators";

export function separator(id: string, title = ""): NavigationMenuItem {
  return { id: `separator-${id}`, key: `separator-${id}`, label: title };
}

export function isBenchmarkSessionRow(session: Session): boolean {
  return session.user_input?.startsWith("Benchmark run coordinator") ?? false;
}

interface BuildSessionMenuItemParams {
  session: Session;
  untitledSession: string;
  visitedSessions: ReadonlySet<string>;
}

export function buildSessionMenuItem({
  session,
  untitledSession,
  visitedSessions,
}: BuildSessionMenuItemParams): NavigationMenuItem {
  const displayName = getSessionListDisplayName(session, untitledSession);
  const timestampSrc =
    session.updated_at || session.updated_time || session.created_at;
  const statusDotTone = resolveSessionSidebarStatusTone({
    status: session.status,
    mergeStatus: session.mergeStatus,
    visited: visitedSessions.has(session.session_id),
  });
  const showBreathingIndicator = shouldShowSessionSidebarBreathingIndicator(
    session.status
  );
  const showTrailingDot = shouldShowSessionSidebarTrailingDot({
    status: session.status,
    tone: statusDotTone,
  });

  return {
    id: session.session_id,
    key: session.session_id,
    label: displayName,
    searchText: getSessionSearchText(session, untitledSession),
    dataTestId: `sidebar-session-item-${session.session_id}`,
    icon: resolveSessionRowIcon(session),
    workingIndicator: showBreathingIndicator
      ? renderBreathingStatusDot()
      : undefined,
    trailingElement: showTrailingDot
      ? renderStatusDot(statusDotTone)
      : undefined,
    shortcut: formatRelativeTime(timestampSrc, "nano"),
    dragPayload: {
      path: `session://${session.session_id}`,
      name: displayName,
      iconType: "session",
    },
  };
}
