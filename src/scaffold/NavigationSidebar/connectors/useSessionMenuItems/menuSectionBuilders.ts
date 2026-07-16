import {
  CHANNEL_LABELS,
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
  let hasHiddenLocalSessions = appendPinnedSessions(items);
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
  const channelGroups = new Map<string, Session[]>();

  for (const session of unpinnedSessions) {
    // Channel-originated sessions go to their own "Channels" section.
    if (session.channel) {
      const bucket = channelGroups.get(session.channel);
      if (bucket) {
        bucket.push(session);
      } else {
        channelGroups.set(session.channel, [session]);
      }
      continue;
    }

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
  let hasHiddenLocalSessions = appendPinnedSessions(items);
  const loadMoreEmitted = new Set<SessionListCategory>();

  // ── Channel groups (Feishu, Telegram, etc.) ──
  const sortedChannelKeys = Array.from(channelGroups.keys()).sort();
  for (const channelKey of sortedChannelKeys) {
    const groupSessions = channelGroups.get(channelKey)!;
    const label =
      CHANNEL_LABELS[channelKey] ??
      channelKey.charAt(0).toUpperCase() + channelKey.slice(1);
    items.push(separator(`channel:${channelKey}`, label));
    const groupHasHidden = appendGroupSessions(
      items,
      `channel:${channelKey}`,
      groupSessions
    );
    if (groupHasHidden) {
      hasHiddenLocalSessions = true;
    }
  }

  // ── Agent Org groups ──
  const sortedAgentOrgGroups = Array.from(agentOrgGroups.entries()).sort(
    ([orgIdA, sessionsA], [orgIdB, sessionsB]) => {
      const labelA = sessionsA[0]?.agentOrgName ?? orgIdA;
      const labelB = sessionsB[0]?.agentOrgName ?? orgIdB;
      return labelA.localeCompare(labelB);
    }
  );

  for (const [orgId, groupSessions] of sortedAgentOrgGroups) {
    const label = groupSessions[0]?.agentOrgName ?? orgId;
    items.push(separator(`agent-org:${orgId}`, label));
    const hasHiddenOrgSessions = appendGroupSessions(
      items,
      `agent-org:${orgId}`,
      groupSessions
    );
    if (hasHiddenOrgSessions) {
      hasHiddenLocalSessions = true;
      loadMoreEmitted.add("rust_agent");
    }
  }

  for (const key of SESSION_GROUP_ORDER) {
    const groupSessions = groups.get(key);
    if (!groupSessions || groupSessions.length === 0) continue;
    items.push(separator(key, SESSION_GROUP_LABELS[key]));
    const groupHasHiddenLocalSessions = appendGroupSessions(
      items,
      `agent:${key}`,
      groupSessions
    );
    hasHiddenLocalSessions =
      groupHasHiddenLocalSessions || hasHiddenLocalSessions;
    const wireCategory = groupKeyToWireCategory(key);
    if (!hasHiddenLocalSessions && !loadMoreEmitted.has(wireCategory)) {
      const row = loadMoreRowFor(wireCategory);
      if (row) {
        items.push(row);
        loadMoreEmitted.add(wireCategory);
      }
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
  let hasHiddenLocalSessions = appendPinnedSessions(items);
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
