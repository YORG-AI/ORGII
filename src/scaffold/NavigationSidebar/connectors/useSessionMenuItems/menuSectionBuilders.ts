import { isImportedHistoryListCategory } from "@src/api/tauri/externalHistory";
import {
  SESSION_GROUP_LABELS,
  SESSION_GROUP_ORDER,
  type SessionGroupKey,
  getSessionGroupKey,
} from "@src/config/sessionAgentGroups";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  type Session,
  type SessionListCategory,
  type SidebarWorkspaceFacet,
  sessionPaginationScopeKey,
} from "@src/store/session";

import { NO_WORKSPACE_KEY } from "../types";
import {
  DATE_GROUP_KEYS,
  type DateGroupKey,
  getDateGroup,
} from "./dateGroupingHelpers";
import { separator } from "./menuItemBuilders";
import { groupKeyToWireCategory } from "./sessionGroupHelpers";
import type {
  AppendAllGroupSessions,
  AppendGroupSessions,
  AppendPinnedSessions,
  ScopedLoadMoreRowFor,
} from "./types";

interface BuildByTimeMenuItemsParams {
  unpinnedSessions: readonly Session[];
  dateGroupLabels: Record<DateGroupKey, string>;
  appendPinnedSessions: AppendPinnedSessions;
  appendGroupSessions: AppendGroupSessions;
  scopedLoadMoreRowFor: ScopedLoadMoreRowFor;
  orgIds: readonly string[];
}

export function buildByTimeMenuItems({
  unpinnedSessions,
  dateGroupLabels,
  appendPinnedSessions,
  appendGroupSessions,
  scopedLoadMoreRowFor,
  orgIds,
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
  appendPinnedSessions(items);
  for (const groupKey of DATE_GROUP_KEYS) {
    const groupSessions = groups[groupKey];
    const scope = {
      kind: "time",
      bucket: groupKey,
      orgIds,
    } as const;
    const scopeRow = scopedLoadMoreRowFor(scope);
    if (groupSessions.length === 0 && !scopeRow) continue;
    items.push(separator(groupKey, dateGroupLabels[groupKey]));
    const hasHiddenLocalSessions = appendGroupSessions(
      items,
      sessionPaginationScopeKey(scope),
      groupSessions
    );
    if (!hasHiddenLocalSessions && scopeRow) items.push(scopeRow);
  }
  return items;
}

interface BuildByAgentMenuItemsParams {
  unpinnedSessions: readonly Session[];
  pinnedSessions: readonly Session[];
  appendPinnedSessions: AppendPinnedSessions;
  appendAllGroupSessions: AppendAllGroupSessions;
  scopedLoadMoreRowFor: ScopedLoadMoreRowFor;
  orgIds: readonly string[];
}

export function buildByAgentMenuItems({
  unpinnedSessions,
  pinnedSessions,
  appendPinnedSessions,
  appendAllGroupSessions,
  scopedLoadMoreRowFor,
  orgIds,
}: BuildByAgentMenuItemsParams): NavigationMenuItem[] {
  const groups = new Map<SessionGroupKey, Session[]>();
  const agentOrgGroups = new Map<string, Session[]>();
  const agentOrgEvidenceLabels = new Map<string, string>();
  const pinnedEvidenceGroupKeys = new Set<SessionGroupKey>();

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
  // By-agent rows are already bounded by one backend cursor per visual source.
  // Render every row returned by that cursor so one click both fetches and
  // reveals the next page; stacking a second client-only page here makes a
  // successful backend read look like a no-op.
  appendPinnedSessions(items);
  const backendPaginationHandled = new Set<SessionListCategory>();
  const backendPaginationRows = new Map<
    SessionListCategory,
    NavigationMenuItem | null
  >();
  const backendPaginationRow = (category: SessionListCategory) => {
    if (!backendPaginationRows.has(category)) {
      backendPaginationRows.set(
        category,
        scopedLoadMoreRowFor({
          kind: "category",
          category,
          orgIds,
        })
      );
    }
    return backendPaginationRows.get(category) ?? null;
  };
  for (const session of pinnedSessions) {
    if (session.agentOrgId) {
      if (backendPaginationRow("rust_agent:agent_org")) {
        if (!agentOrgGroups.has(session.agentOrgId)) {
          agentOrgGroups.set(session.agentOrgId, []);
        }
        agentOrgEvidenceLabels.set(
          session.agentOrgId,
          session.agentOrgName ?? session.agentOrgId
        );
      }
      continue;
    }
    const key = getSessionGroupKey(session.session_id);
    // Imported history has no persisted pin semantics. Never use a stale or
    // synthetic frontend flag to invent an empty provider group.
    if (isImportedHistoryListCategory(key)) continue;
    if (backendPaginationRow(groupKeyToWireCategory(key))) {
      pinnedEvidenceGroupKeys.add(key);
    }
  }
  const appendBackendPagination = (category: SessionListCategory) => {
    if (backendPaginationHandled.has(category)) return;
    backendPaginationHandled.add(category);
    const row = backendPaginationRow(category);
    if (row) items.push(row);
  };
  const sortedAgentOrgGroups = Array.from(agentOrgGroups.entries()).sort(
    ([orgIdA, sessionsA], [orgIdB, sessionsB]) => {
      const labelA =
        sessionsA[0]?.agentOrgName ??
        agentOrgEvidenceLabels.get(orgIdA) ??
        orgIdA;
      const labelB =
        sessionsB[0]?.agentOrgName ??
        agentOrgEvidenceLabels.get(orgIdB) ??
        orgIdB;
      return labelA.localeCompare(labelB);
    }
  );

  for (const [orgId, groupSessions] of sortedAgentOrgGroups) {
    const label =
      groupSessions[0]?.agentOrgName ??
      agentOrgEvidenceLabels.get(orgId) ??
      orgId;
    items.push(separator(`agent-org:${orgId}`, label));
    appendAllGroupSessions(items, groupSessions);
  }
  if (sortedAgentOrgGroups.length > 0) {
    appendBackendPagination("rust_agent:agent_org");
  }

  const populatedGroupKeys = SESSION_GROUP_ORDER.filter(
    (key) =>
      (groups.get(key)?.length ?? 0) > 0 || pinnedEvidenceGroupKeys.has(key)
  );
  const appendAgentGroup = (key: SessionGroupKey) => {
    const groupSessions = groups.get(key) ?? [];
    if (groupSessions.length === 0 && !pinnedEvidenceGroupKeys.has(key)) return;
    items.push(separator(key, SESSION_GROUP_LABELS[key]));
    appendAllGroupSessions(items, groupSessions);
  };

  // Each visual section owns the matching backend cursor. In particular,
  // SDE cannot consume Agent Org/OS/Wingman offsets and CLI cannot consume an
  // imported OpenCode application's offset.
  for (const key of populatedGroupKeys) {
    const wireCategory = groupKeyToWireCategory(key);
    appendAgentGroup(key);
    appendBackendPagination(wireCategory);
  }
  return items;
}

interface BuildByWorkspaceMenuItemsParams {
  unpinnedSessions: readonly Session[];
  repoPathToName: ReadonlyMap<string, string>;
  noWorkspaceLabel: string;
  appendPinnedSessions: AppendPinnedSessions;
  appendGroupSessions: AppendGroupSessions;
  scopedLoadMoreRowFor: ScopedLoadMoreRowFor;
  orgIds: readonly string[];
  workspaceFacets: readonly SidebarWorkspaceFacet[];
  workspaceFacetLoadMoreRow: NavigationMenuItem | null;
}

export function buildByWorkspaceMenuItems({
  unpinnedSessions,
  repoPathToName,
  noWorkspaceLabel,
  appendPinnedSessions,
  appendGroupSessions,
  scopedLoadMoreRowFor,
  orgIds,
  workspaceFacets,
  workspaceFacetLoadMoreRow,
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
  for (const facet of workspaceFacets) {
    const key = facet.repoPath ?? NO_WORKSPACE_KEY;
    if (!groups.has(key)) groups.set(key, []);
  }

  const orderedKeys = Array.from(groups.keys()).sort((keyA, keyB) => {
    if (keyA === NO_WORKSPACE_KEY) return 1;
    if (keyB === NO_WORKSPACE_KEY) return -1;
    const labelA = repoPathToName.get(keyA) ?? keyA.split("/").pop() ?? keyA;
    const labelB = repoPathToName.get(keyB) ?? keyB.split("/").pop() ?? keyB;
    return labelA.localeCompare(labelB);
  });

  const items: NavigationMenuItem[] = [];
  appendPinnedSessions(items);
  for (const key of orderedKeys) {
    const groupSessions = groups.get(key) ?? [];
    const label =
      key === NO_WORKSPACE_KEY
        ? noWorkspaceLabel
        : (repoPathToName.get(key) ?? key.split("/").pop() ?? key);
    items.push(separator(key, label));
    const scope = {
      kind: "workspace" as const,
      repoPath: key === NO_WORKSPACE_KEY ? null : key,
      orgIds,
    };
    const hasHiddenLocalSessions = appendGroupSessions(
      items,
      sessionPaginationScopeKey(scope),
      groupSessions
    );
    if (!hasHiddenLocalSessions) {
      const scopeRow = scopedLoadMoreRowFor(scope);
      if (scopeRow) items.push(scopeRow);
    }
  }
  if (workspaceFacetLoadMoreRow) items.push(workspaceFacetLoadMoreRow);
  return items;
}
