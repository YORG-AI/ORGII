/**
 * Org/cloud scope resolution + My Conversations pagination for
 * `WorkstationSidebarConnector` (`index.tsx`): kicks off the session
 * refresh effects, merges chat-panel TUI sessions into the sorted session
 * list, resolves the active org scope via `useSidebarOrgScope`, the repo
 * path→name map, the group-by/include-external view atoms, the "My
 * Conversations" cloud pagination window, and the cloud sign-in identity
 * used by the org selector.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildOrg2CloudLoginUrl } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { createLogger } from "@src/hooks/logger";
import { repoMapAtom } from "@src/store/repo";
import {
  BASE_SESSION_LIST_CATEGORIES,
  DEFAULT_SESSION_ORG_ID,
  type Session,
  beginSidebarSearchRequest,
  loadMoreSessionScope,
  loadMoreSidebarPinnedPage,
  loadMoreSidebarWorkspaceFacetPage,
  loadSessionRoster,
  loadSidebarSearchResults,
  normalizeSidebarDiscoveryOrgIds,
  scopedSessionPaginationAtom,
  sessionPaginationScopeKey,
  sidebarDiscoveryGenerationAtom,
  sidebarPinnedPagesAtom,
  sidebarPinnedScopeKey,
  sidebarSearchQueryKey,
  sidebarSearchResultsAtom,
  sidebarWorkspaceFacetPagesAtom,
  sidebarWorkspaceFacetScopeKey,
} from "@src/store/session";
import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "@src/store/session/dataSourceConfigAtom";

import {
  sidebarGroupByAtom,
  sidebarIncludeExternalAtom,
} from "../sidebarGroupByAtom";
import {
  buildRepoPathToName,
  sortSessionsByActivity,
} from "../workstationSidebarData";
import { CLOUD_SESSION_SECTION_PAGE_SIZE } from "./cloudScopedMenuItems";
import { resetScopedSectionPagination } from "./sectionPagination";
import { useChatPanelTuiSidebarSessions } from "./sidebarMenuCollections";
import { useSidebarSessionRefreshEffects } from "./sidebarSessionRefresh";
import { useSidebarOrgScope } from "./useSidebarOrgScope";

const logger = createLogger("WorkstationSidebar");

interface UseWorkstationSidebarScopeAndPaginationParams {
  sessions: Session[];
  workstationSearchQuery: string;
}

export function useWorkstationSidebarScopeAndPagination({
  sessions,
  workstationSearchQuery,
}: UseWorkstationSidebarScopeAndPaginationParams) {
  useSidebarSessionRefreshEffects();

  const chatPanelTuiSessions = useChatPanelTuiSidebarSessions();
  const sortedSessions = useMemo(
    () => sortSessionsByActivity([...chatPanelTuiSessions, ...sessions]),
    [chatPanelTuiSessions, sessions]
  );
  const {
    activeCloudOrgId,
    activeOrgId,
    activeProjectOrgId,
    cloudSessionFilter,
    cloudTaggedSessionIds,
    handleCloudSessionFilterChange,
    manageableCloudOrg,
    manageableLocalOrg,
    orgSelectorOptions,
    personalHiddenCloudTaggedIds,
    sessionFilterOrgIds,
    setSelectedOrgId,
  } = useSidebarOrgScope({ sortedSessions });
  const repoMap = useAtomValue(repoMapAtom);
  const repoPathToName = useMemo(() => buildRepoPathToName(repoMap), [repoMap]);

  const [groupByMode, setGroupByMode] = useAtom(sidebarGroupByAtom);
  const [includeExternal, setIncludeExternal] = useAtom(
    sidebarIncludeExternalAtom
  );
  const externalSessionsEnabled = useAtomValue(externalSessionsEnabledAtom);
  const dataSourceConfig = useAtomValue(dataSourceConfigAtom);
  const searchResults = useAtomValue(sidebarSearchResultsAtom);
  const discoveryGeneration = useAtomValue(sidebarDiscoveryGenerationAtom);
  const pinnedPages = useAtomValue(sidebarPinnedPagesAtom);
  const workspaceFacetPages = useAtomValue(sidebarWorkspaceFacetPagesAtom);
  const scopedSessionPagination = useAtomValue(scopedSessionPaginationAtom);
  const sidebarOrgIds = useMemo(
    () =>
      normalizeSidebarDiscoveryOrgIds(
        sessionFilterOrgIds ? Array.from(sessionFilterOrgIds) : []
      ),
    [sessionFilterOrgIds]
  );
  const sidebarOrgIdsKey = sidebarOrgIds.join("\u001f");
  const isPersonalOrgScope =
    sidebarOrgIds.length === 1 && sidebarOrgIds[0] === DEFAULT_SESSION_ORG_ID;
  useEffect(() => {
    if (isPersonalOrgScope) return;
    for (const category of BASE_SESSION_LIST_CATEGORIES) {
      const scopeKey = sessionPaginationScopeKey({
        kind: "category",
        category,
        orgIds: sidebarOrgIds,
      });
      if (!scopedSessionPagination[scopeKey]) {
        void loadMoreSessionScope(scopeKey);
      }
    }
  }, [
    isPersonalOrgScope,
    scopedSessionPagination,
    sidebarOrgIds,
    sidebarOrgIdsKey,
  ]);
  const disabledExternalHistorySources = useMemo(
    () =>
      Object.entries(dataSourceConfig)
        .filter(([, config]) => config?.enabled === false)
        .map(([sourceId]) => sourceId)
        .sort(),
    [dataSourceConfig]
  );
  const disabledExternalHistorySourcesKey =
    disabledExternalHistorySources.join("\u001f");
  const sourcePolicyKey = `${externalSessionsEnabled ? "external" : "native"}\u001e${disabledExternalHistorySourcesKey}`;
  const previousSourcePolicyKey = useRef(sourcePolicyKey);
  useEffect(() => {
    if (previousSourcePolicyKey.current === sourcePolicyKey) return;
    previousSourcePolicyKey.current = sourcePolicyKey;
    void loadSessionRoster({ forceRefresh: true });
  }, [sourcePolicyKey]);
  const includeExternalHistory = includeExternal && externalSessionsEnabled;
  const activeSearchQueryKey = sidebarSearchQueryKey({
    query: workstationSearchQuery,
    orgIds: sidebarOrgIds,
    includeExternalHistory,
    disabledExternalHistorySources,
  });
  useEffect(() => {
    const request = {
      query: workstationSearchQuery,
      orgIds: sidebarOrgIds,
      includeExternal,
    };
    const requestToken = beginSidebarSearchRequest(request);
    if (!workstationSearchQuery.trim()) return;
    const timeout = window.setTimeout(() => {
      void loadSidebarSearchResults(request, requestToken);
    }, 200);
    return () => window.clearTimeout(timeout);
  }, [
    activeSearchQueryKey,
    discoveryGeneration,
    disabledExternalHistorySources,
    disabledExternalHistorySourcesKey,
    externalSessionsEnabled,
    includeExternal,
    includeExternalHistory,
    sidebarOrgIds,
    sidebarOrgIdsKey,
    workstationSearchQuery,
  ]);

  const pinnedScopeKey = sidebarPinnedScopeKey(sidebarOrgIds);
  const activePinnedPage = pinnedPages[pinnedScopeKey];
  useEffect(() => {
    if (activePinnedPage) return;
    void loadMoreSidebarPinnedPage({ orgIds: sidebarOrgIds });
  }, [activePinnedPage, pinnedScopeKey, sidebarOrgIds, sidebarOrgIdsKey]);

  const workspaceFacetScopeKey = sidebarWorkspaceFacetScopeKey({
    orgIds: sidebarOrgIds,
    includeExternalHistory,
    disabledExternalHistorySources,
  });
  const activeWorkspaceFacetPage = workspaceFacetPages[workspaceFacetScopeKey];
  useEffect(() => {
    if (groupByMode !== "byWorkspace" || activeWorkspaceFacetPage) return;
    void loadMoreSidebarWorkspaceFacetPage({
      orgIds: sidebarOrgIds,
      includeExternal,
    });
  }, [
    activeWorkspaceFacetPage,
    groupByMode,
    includeExternal,
    sidebarOrgIds,
    sidebarOrgIdsKey,
    workspaceFacetScopeKey,
  ]);

  const sortedSidebarSessions = useMemo(() => {
    const sessionsById = new Map<string, Session>();
    for (const session of activePinnedPage?.sessions ?? []) {
      sessionsById.set(session.session_id, session);
    }
    if (
      activeSearchQueryKey &&
      searchResults.queryKey === activeSearchQueryKey
    ) {
      for (const session of searchResults.sessions) {
        sessionsById.set(session.session_id, session);
      }
    }
    // Ordinary/live rows win so pin toggles and status updates immediately
    // override a discovery snapshot of the same session.
    for (const session of sortedSessions) {
      sessionsById.set(session.session_id, session);
    }
    return sortSessionsByActivity(Array.from(sessionsById.values()));
  }, [
    activePinnedPage?.sessions,
    activeSearchQueryKey,
    searchResults.queryKey,
    searchResults.sessions,
    sortedSessions,
  ]);
  const cloudMyPaginationScopeKey = activeCloudOrgId
    ? [
        activeCloudOrgId,
        workstationSearchQuery,
        groupByMode,
        includeExternal ? "external" : "native",
      ].join("\u001f")
    : "";
  const [cloudMyPagination, setCloudMyPagination] = useState({
    scopeKey: "",
    visibleCount: CLOUD_SESSION_SECTION_PAGE_SIZE,
  });
  const resetCloudMyPagination = useCallback(() => {
    setCloudMyPagination((current) =>
      resetScopedSectionPagination(current, CLOUD_SESSION_SECTION_PAGE_SIZE)
    );
  }, []);
  const cloudMySessionsVisibleCount =
    cloudMyPagination.scopeKey === cloudMyPaginationScopeKey
      ? cloudMyPagination.visibleCount
      : CLOUD_SESSION_SECTION_PAGE_SIZE;
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const cloudSignedInIdentity = cloudAuth
    ? (cloudAuth.profile?.displayName ??
      cloudAuth.profile?.primaryEmail ??
      cloudAuth.userId)
    : null;
  const handleCloudSignIn = useCallback(() => {
    openUrl(buildOrg2CloudLoginUrl()).catch((error: unknown) => {
      logger.error("failed to open ORG2 Cloud login in system browser", error);
    });
  }, []);

  return {
    sortedSessions: sortedSidebarSessions,
    activeCloudOrgId,
    activeOrgId,
    activeProjectOrgId,
    cloudSessionFilter,
    cloudTaggedSessionIds,
    handleCloudSessionFilterChange,
    manageableCloudOrg,
    manageableLocalOrg,
    orgSelectorOptions,
    personalHiddenCloudTaggedIds,
    sessionFilterOrgIds,
    sidebarOrgIds,
    activePinnedPage,
    activeWorkspaceFacetPage,
    pinnedScopeKey,
    workspaceFacetScopeKey,
    setSelectedOrgId,
    repoPathToName,
    groupByMode,
    setGroupByMode,
    includeExternal,
    setIncludeExternal,
    cloudMyPaginationScopeKey,
    cloudMySessionsVisibleCount,
    setCloudMyPagination,
    resetCloudMyPagination,
    cloudSignedInIdentity,
    handleCloudSignIn,
  };
}
