import { MoreHorizontal, Plus } from "lucide-react";

import {
  SESSION_GROUP_LABELS,
  SESSION_GROUP_ORDER,
  type SessionGroupKey,
  getSessionGroupKey,
} from "@src/config/sessionAgentGroups";
import type {
  NavigationMenuItem,
  NavigationMenuRowAction,
} from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import { NO_WORKSPACE_KEY } from "../types";
import { workspaceGroupKey } from "../workspaceGroupKey";
import {
  DATE_GROUP_KEYS,
  type DateGroupKey,
  getDateGroup,
} from "./dateGroupingHelpers";
import {
  renderHiddenSectionIndicator,
  renderPinnedSectionIndicator,
  separator,
} from "./menuItemBuilders";
import { groupKeyToWireCategory } from "./sessionGroupHelpers";
import type {
  AppendGroupSessions,
  AppendPinnedSessions,
  AppendTrailingLoadMoreItems,
  LoadMoreRowFor,
  WorkspaceGroupActions,
} from "./types";

interface BuildByTimeMenuItemsParams {
  unpinnedSessions: readonly Session[];
  dateGroupLabels: Record<DateGroupKey, string>;
  appendPinnedSessions: AppendPinnedSessions;
  appendGroupSessions: AppendGroupSessions;
  appendTrailingLoadMoreItems: AppendTrailingLoadMoreItems;
}

export function buildByTimeMenuItems({
  unpinnedSessions,
  dateGroupLabels,
  appendPinnedSessions,
  appendGroupSessions,
  appendTrailingLoadMoreItems,
}: BuildByTimeMenuItemsParams): NavigationMenuItem[] {
  const groups: Record<DateGroupKey, Session[]> = {
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  };
  for (const session of unpinnedSessions) {
    groups[getDateGroup(session)].push(session);
  }

  const items: NavigationMenuItem[] = [];
  let hasHiddenLocalSessions = appendPinnedSessions(items, false);
  for (const groupKey of DATE_GROUP_KEYS) {
    const groupSessions = groups[groupKey];
    if (groupSessions.length === 0) continue;
    items.push(separator(groupKey, dateGroupLabels[groupKey]));
    hasHiddenLocalSessions =
      appendGroupSessions(items, `time:${groupKey}`, groupSessions) ||
      hasHiddenLocalSessions;
  }
  if (!hasHiddenLocalSessions) {
    appendTrailingLoadMoreItems(items);
  }
  return items;
}

interface BuildByAgentMenuItemsParams {
  unpinnedSessions: readonly Session[];
  appendPinnedSessions: AppendPinnedSessions;
  appendGroupSessions: AppendGroupSessions;
  loadMoreRowFor: LoadMoreRowFor;
}

export function buildByAgentMenuItems({
  unpinnedSessions,
  appendPinnedSessions,
  appendGroupSessions,
  loadMoreRowFor,
}: BuildByAgentMenuItemsParams): NavigationMenuItem[] {
  const groups = new Map<SessionGroupKey, Session[]>();
  const agentOrgGroups = new Map<string, Session[]>();

  for (const session of unpinnedSessions) {
    if (session.agentOrgId) {
      const bucket = agentOrgGroups.get(session.agentOrgId);
      if (bucket) {
        bucket.push(session);
      } else {
        agentOrgGroups.set(session.agentOrgId, [session]);
      }
      continue;
    }

    const key = getSessionGroupKey(session.session_id);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      groups.set(key, [session]);
    }
  }

  const items: NavigationMenuItem[] = [];
  appendPinnedSessions(items, true);
  const sortedAgentOrgGroups = Array.from(agentOrgGroups.entries()).sort(
    ([orgIdA, sessionsA], [orgIdB, sessionsB]) => {
      const labelA = sessionsA[0]?.agentOrgName ?? orgIdA;
      const labelB = sessionsB[0]?.agentOrgName ?? orgIdB;
      return labelA.localeCompare(labelB);
    }
  );

  let agentOrgHasHiddenRows = false;
  for (const [orgId, groupSessions] of sortedAgentOrgGroups) {
    const label = groupSessions[0]?.agentOrgName ?? orgId;
    items.push(separator(`agent-org:${orgId}`, label));
    const hasHiddenOrgSessions = appendGroupSessions(
      items,
      `agent-org:${orgId}`,
      groupSessions
    );
    if (hasHiddenOrgSessions) {
      agentOrgHasHiddenRows = true;
    }
  }
  if (!agentOrgHasHiddenRows) {
    const row = loadMoreRowFor("agent_org_root");
    if (row) items.push(row);
  }

  const hiddenByCategory = new Set<SessionListCategory>();
  const lastGroupIndexByCategory = new Map<SessionListCategory, number>();
  SESSION_GROUP_ORDER.forEach((key, index) => {
    lastGroupIndexByCategory.set(groupKeyToWireCategory(key), index);
  });
  for (const [groupIndex, key] of SESSION_GROUP_ORDER.entries()) {
    const groupSessions = groups.get(key);
    const wireCategory = groupKeyToWireCategory(key);
    if (groupSessions && groupSessions.length > 0) {
      items.push(separator(key, SESSION_GROUP_LABELS[key]));
      const groupHasHiddenLocalSessions = appendGroupSessions(
        items,
        `agent:${key}`,
        groupSessions
      );
      if (groupHasHiddenLocalSessions) {
        hiddenByCategory.add(wireCategory);
      }
    }
    if (
      lastGroupIndexByCategory.get(wireCategory) === groupIndex &&
      !hiddenByCategory.has(wireCategory)
    ) {
      const row = loadMoreRowFor(wireCategory);
      if (row) items.push(row);
    }
  }
  return items;
}

interface BuildByWorkspaceMenuItemsParams {
  unpinnedSessions: readonly Session[];
  repoPathToName: ReadonlyMap<string, string>;
  noWorkspaceLabel: string;
  appendPinnedSessions: AppendPinnedSessions;
  appendGroupSessions: AppendGroupSessions;
  appendTrailingLoadMoreItems: AppendTrailingLoadMoreItems;
  workspaceGroupActions?: WorkspaceGroupActions;
}

/**
 * Hover actions on one workspace separator, `…` first then `+`.
 *
 * `+` is omitted for the "No Workspace" bucket: it is not a directory, so
 * there is nothing to source a new session at — but it can still be pinned or
 * hidden like any other group.
 */
function workspaceHeaderActions(
  key: string,
  actions: WorkspaceGroupActions | undefined
): NavigationMenuRowAction[] | undefined {
  if (!actions) return undefined;
  const rowActions: NavigationMenuRowAction[] = [
    {
      icon: MoreHorizontal,
      label: actions.moreActionsLabel,
      dataTestId: `sidebar-workspace-more-${key}`,
      onClick: () => actions.onOpenMenu(key),
    },
  ];
  if (key !== NO_WORKSPACE_KEY) {
    rowActions.push({
      icon: Plus,
      label: actions.createSessionLabel,
      dataTestId: `sidebar-workspace-new-session-${key}`,
      onClick: () => actions.onCreateSession(key),
    });
  }
  return rowActions;
}

export function buildByWorkspaceMenuItems({
  unpinnedSessions,
  repoPathToName,
  noWorkspaceLabel,
  appendPinnedSessions,
  appendGroupSessions,
  appendTrailingLoadMoreItems,
  workspaceGroupActions,
}: BuildByWorkspaceMenuItemsParams): NavigationMenuItem[] {
  const groups = new Map<string, Session[]>();
  for (const session of unpinnedSessions) {
    const key = workspaceGroupKey(session);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      groups.set(key, [session]);
    }
  }

  const pinnedKeys = workspaceGroupActions?.pinnedWorkspaceKeys;
  const hiddenKeys = workspaceGroupActions?.hiddenWorkspaceKeys;
  // Rank first, label second: pinned groups on top, hidden ones at the bottom,
  // "No Workspace" just above them, and everything else alphabetical between.
  const rankOf = (key: string): number => {
    if (hiddenKeys?.has(key)) return 3;
    // Pinned wins over the No-Workspace demotion: pinning that bucket is a
    // deliberate "keep this on top" just like pinning a named workspace.
    if (pinnedKeys?.has(key)) return 0;
    if (key === NO_WORKSPACE_KEY) return 2;
    return 1;
  };
  const orderedKeys = Array.from(groups.keys()).sort((keyA, keyB) => {
    const rankDelta = rankOf(keyA) - rankOf(keyB);
    if (rankDelta !== 0) return rankDelta;
    const labelA = repoPathToName.get(keyA) ?? keyA.split("/").pop() ?? keyA;
    const labelB = repoPathToName.get(keyB) ?? keyB.split("/").pop() ?? keyB;
    return labelA.localeCompare(labelB);
  });

  const items: NavigationMenuItem[] = [];
  let hasHiddenLocalSessions = appendPinnedSessions(items, false);
  for (const key of orderedKeys) {
    const groupSessions = groups.get(key);
    if (!groupSessions || groupSessions.length === 0) continue;
    const label =
      key === NO_WORKSPACE_KEY
        ? noWorkspaceLabel
        : (repoPathToName.get(key) ?? key.split("/").pop() ?? key);
    const header = separator(key, label);
    // Pinned and hidden are mutually exclusive (see `useWorkspaceGroupActions`),
    // so a header carries at most one state glyph.
    if (pinnedKeys?.has(key)) {
      header.iconElement = renderPinnedSectionIndicator();
    } else if (hiddenKeys?.has(key)) {
      header.iconElement = renderHiddenSectionIndicator();
    }
    const rowActions = workspaceHeaderActions(key, workspaceGroupActions);
    if (rowActions) header.rowActions = rowActions;
    items.push(header);
    hasHiddenLocalSessions =
      appendGroupSessions(items, `workspace:${key}`, groupSessions) ||
      hasHiddenLocalSessions;
  }
  if (!hasHiddenLocalSessions) {
    appendTrailingLoadMoreItems(items);
  }
  return items;
}
