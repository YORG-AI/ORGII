import {
  SESSION_GROUP_LABELS,
  SESSION_GROUP_ORDER,
  type SessionGroupKey,
  getSessionGroupKey,
} from "@src/config/sessionAgentGroups";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session, SessionListCategory } from "@src/store/session";

import { NO_WORKSPACE_KEY } from "../types";
import {
  DATE_GROUP_KEYS,
  type DateGroupKey,
  getDateGroup,
} from "./dateGroupingHelpers";
import { separator } from "./menuItemBuilders";
import { groupKeyToWireCategory } from "./sessionGroupHelpers";
import type {
  AppendGroupSessions,
  AppendPinnedSessions,
  AppendTrailingLoadMoreItems,
  LoadMoreRowFor,
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
}

export function buildByWorkspaceMenuItems({
  unpinnedSessions,
  repoPathToName,
  noWorkspaceLabel,
  appendPinnedSessions,
  appendGroupSessions,
  appendTrailingLoadMoreItems,
}: BuildByWorkspaceMenuItemsParams): NavigationMenuItem[] {
  const groups = new Map<string, Session[]>();
  for (const session of unpinnedSessions) {
    const rawPath = session.repoPath?.replace(/\/+$/, "") ?? "";
    const key = rawPath || NO_WORKSPACE_KEY;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(session);
    } else {
      groups.set(key, [session]);
    }
  }

  const orderedKeys = Array.from(groups.keys()).sort((keyA, keyB) => {
    if (keyA === NO_WORKSPACE_KEY) return 1;
    if (keyB === NO_WORKSPACE_KEY) return -1;
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
    items.push(separator(key, label));
    hasHiddenLocalSessions =
      appendGroupSessions(items, `workspace:${key}`, groupSessions) ||
      hasHiddenLocalSessions;
  }
  if (!hasHiddenLocalSessions) {
    appendTrailingLoadMoreItems(items);
  }
  return items;
}
