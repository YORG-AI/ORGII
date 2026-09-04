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
import { useCallback, useMemo, useState } from "react";

import { buildOrg2CloudLoginUrl } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { createLogger } from "@src/hooks/logger";
import { repoMapAtom } from "@src/store/repo";
import type { Session } from "@src/store/session";

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
}

export function useWorkstationSidebarScopeAndPagination({
  sessions,
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
    orgSelectorLoading,
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
  const cloudMyPaginationScopeKey = activeCloudOrgId
    ? [
        activeCloudOrgId,
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
  const cloudSignedInAvatarUrl = cloudAuth?.profile?.avatarUrl;
  const handleCloudSignIn = useCallback(() => {
    openUrl(buildOrg2CloudLoginUrl()).catch((error: unknown) => {
      logger.error("failed to open ORG2 Cloud login in system browser", error);
    });
  }, []);

  return {
    sortedSessions,
    activeCloudOrgId,
    activeOrgId,
    activeProjectOrgId,
    cloudSessionFilter,
    cloudTaggedSessionIds,
    handleCloudSessionFilterChange,
    manageableCloudOrg,
    manageableLocalOrg,
    orgSelectorLoading,
    orgSelectorOptions,
    personalHiddenCloudTaggedIds,
    sessionFilterOrgIds,
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
    cloudSignedInAvatarUrl,
    cloudSignedInIdentity,
    handleCloudSignIn,
  };
}
