import { getSessionGroupKey } from "@src/config/sessionAgentGroups";
import { SESSION_SIDEBAR_PAGE_SIZE, type Session } from "@src/store/session";

import { type GroupByMode } from "./types";
import { getDateGroup } from "./useSessionMenuItems/dateGroupingHelpers";
import { workspaceGroupKey } from "./workspaceGroupKey";

function visibleGroupIdForSession(
  session: Session,
  groupByMode: GroupByMode
): string {
  if (session.pinned) return "pinned";
  if (groupByMode === "byTime") {
    return `time:${getDateGroup(session)}`;
  }
  if (groupByMode === "byWorkspace") {
    return `workspace:${workspaceGroupKey(session)}`;
  }
  if (session.agentOrgId) return `agent-org:${session.agentOrgId}`;
  return `agent:${getSessionGroupKey(session.session_id)}`;
}

/**
 * Increase every UI group touched by one backend page. A shared Standalone
 * page can contain SDE, Wingman, and Custom sessions, so updating only the
 * group that owns the clicked footer would leave some returned rows hidden.
 */
export function expandVisibleGroupsForSessions(
  previousCounts: ReadonlyMap<string, number>,
  sessions: readonly Session[],
  groupByMode: GroupByMode
): Map<string, number> {
  const addedByGroup = new Map<string, number>();
  for (const session of sessions) {
    const groupId = visibleGroupIdForSession(session, groupByMode);
    addedByGroup.set(groupId, (addedByGroup.get(groupId) ?? 0) + 1);
  }

  const nextCounts = new Map(previousCounts);
  for (const [groupId, added] of addedByGroup) {
    const current = nextCounts.get(groupId) ?? SESSION_SIDEBAR_PAGE_SIZE;
    nextCounts.set(groupId, current + added);
  }
  return nextCounts;
}
