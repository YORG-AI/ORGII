/**
 * Cloud-org "Team sessions" sidebar section (managed ORG2 Cloud scope).
 *
 * Replaces the Cloud Org panel's shared-sessions list: when the sidebar's
 * active scope is a cloud org, teammates' shared sessions render as
 * collapsible fork-threaded groups under a separator-headed section.
 * Threads come from the pure `buildCloudSessionThreads` helper; replay/fork
 * ride the same canonical `useCloudSessionActions` used by Kanban List.
 *
 * Team Conversations is remote-only: exact local-device rows are filtered
 * before grouping and stay under My Sessions. Same-account rows without a
 * matching local session id are retained because they came from another
 * device. Every rendered row gets a `cloudremote-<orgId>|<rowId>` id.
 *
 * Parent-row choice: a thread root sets `navigableParent`, so a body/label
 * click OPENS the source session (replay/open) while the dedicated chevron
 * toggles the fork thread — without the flag the primitive treats a
 * children-bearing row as a group header whose whole body only toggles,
 * which stranded fork sources as unclickable once a fork added a child row.
 * The primitive renders hover rowActions on LEAF rows only, so Replay/Fork
 * hover buttons appear on descendants and on single-row threads (rendered
 * as leaves); a multi-row thread's root keeps click-to-replay but has no
 * hover fork button — no self-duplicate child row is injected.
 *
 * This hook is a coordinator: row construction, menu-item assembly, roster
 * loading, local-hydration bookkeeping, and the member-filter dropdown each
 * live in a sibling `cloudSessionsSection.*` module (see those files' own
 * header comments).
 */
import { useAtom, useAtomValue, useStore } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { deleteSession as deleteLocalSession } from "@src/api/tauri/agent";
import { deleteOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import Message from "@src/components/Message";
import {
  buildCloudRemoteItemId,
  includeRevealedCloudRow,
  parseCloudRemoteItemId,
} from "@src/features/Org2Cloud/cloudRemoteItemId";
import { filterCloudSessionRows } from "@src/features/Org2Cloud/cloudSessionFilter";
import {
  buildCloudSessionThreads,
  collectCloudFlatListExcludedSessionIds,
} from "@src/features/Org2Cloud/cloudSessionThreads";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudPresenceAtom } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
} from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import { useCloudSessionActions } from "@src/features/Org2Cloud/useCloudSessionActions";
import { useRefreshSpin } from "@src/hooks/ui";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { removeSession } from "@src/store/session";

import {
  CLOUD_SESSION_SECTION_PAGE_SIZE,
  CLOUD_TEAM_SESSIONS_LOAD_MORE_ID,
} from "./cloudScopedMenuItems";
import { useCloudMemberFilterDropdown } from "./cloudSessionsSection.MemberFilterDropdown";
import {
  type CloudAutoReplaySkipReason,
  useCloudSessionAutoReplayReveal,
} from "./cloudSessionsSection.autoReplayReveal";
import {
  HIDDEN_REMOTE_SESSIONS_STORAGE_KEY,
  hiddenRemoteSessionKey,
  readHiddenRemoteSessionIds,
} from "./cloudSessionsSection.hiddenRemoteSessions";
import { useCloudLocalSessionHydration } from "./cloudSessionsSection.localHydration";
import { useCloudTeamSessionMenuItems } from "./cloudSessionsSection.menuItems";
import { useCloudRemoteRowMaps } from "./cloudSessionsSection.remoteRowMaps";
import { useCloudOrgRosterMembers } from "./cloudSessionsSection.rosterMembers";
import { useCloudSessionRowItemBuilder } from "./cloudSessionsSection.rowItemBuilder";
import type {
  MemberFilterMenuState,
  UseCloudSessionsSectionParams,
  UseCloudSessionsSectionResult,
} from "./cloudSessionsSection.types";
import { resetScopedSectionPagination } from "./sectionPagination";

export function useCloudSessionsSection({
  orgId,
  sessions,
  filter,
  activeSessionId,
  localSessionHydrationLimit,
  revealedMenuItemId,
  onFilterChange,
}: UseCloudSessionsSectionParams): UseCloudSessionsSectionResult {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const store = useStore();
  const { rows, state, fetchedAt, documentVisible, refresh } =
    useCloudOrgRemoteSessions(orgId);
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(
      refresh,
      false,
      orgId ? `cloud-team-sessions:${orgId}` : undefined
    );
  const { replaySession, forkSession, busySessionRowId } =
    useCloudSessionActions(orgId);
  const presenceMap = useAtomValue(org2CloudPresenceAtom);
  const pushedMetadata = useAtomValue(org2CloudPushedMetadataAtom);
  const pushCursors = useAtomValue(org2CloudPushCursorsAtom);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const selfUserId = auth?.userId ?? null;
  const rosterMembers = useCloudOrgRosterMembers({
    orgId,
    auth,
    setAuth,
    store,
  });
  const [memberMenu, setMemberMenu] = useState<MemberFilterMenuState | null>(
    null
  );
  const [hiddenRemoteSessionIds, setHiddenRemoteSessionIds] = useState(
    readHiddenRemoteSessionIds
  );

  const { localOwnSessionIds, cloudLocalSessionIds } =
    useCloudLocalSessionHydration({
      orgId,
      sessions,
      pushedMetadata,
      pushCursors,
      selfUserId,
      rows,
      documentVisible,
      localSessionHydrationLimit,
    });

  const unhiddenRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          !hiddenRemoteSessionIds.has(hiddenRemoteSessionKey(row.orgId, row.id))
      ),
    [hiddenRemoteSessionIds, rows]
  );

  const visibleRows = useMemo(() => {
    const filtered = filterCloudSessionRows(unhiddenRows, filter);
    // Cross-surface navigation bypasses presentation filters for one row but
    // never mutates the user's persistent Team Sessions filter.
    return includeRevealedCloudRow(
      filtered,
      unhiddenRows,
      orgId,
      revealedMenuItemId
    );
  }, [filter, orgId, revealedMenuItemId, unhiddenRows]);

  const threads = useMemo(
    () =>
      orgId
        ? buildCloudSessionThreads(visibleRows, {
            // Filtering happens before grouping so duplicate suppression and
            // thread roots derive from the exact visible row set.
            memberFilter: null,
            localOwnSessionIds,
            viewerUserId: selfUserId,
          })
        : [],
    [orgId, visibleRows, localOwnSessionIds, selfUserId]
  );
  const teamPaginationScopeKey = useMemo(() => {
    if (!orgId) return "";
    const memberKey = filter.kind === "member" ? filter.ownerUserId : "";
    return `${orgId}\u001f${filter.kind}\u001f${memberKey}`;
  }, [filter, orgId]);
  const [teamPagination, setTeamPagination] = useState({
    scopeKey: "",
    visibleCount: CLOUD_SESSION_SECTION_PAGE_SIZE,
  });
  const requestedTeamVisibleCount =
    teamPagination.scopeKey === teamPaginationScopeKey
      ? teamPagination.visibleCount
      : CLOUD_SESSION_SECTION_PAGE_SIZE;
  const revealedThreadIndex = useMemo(() => {
    if (!revealedMenuItemId) return -1;
    return threads.findIndex((thread) =>
      [thread.root, ...thread.descendants].some((threadRow) => {
        const itemId = buildCloudRemoteItemId(
          threadRow.row.orgId,
          threadRow.row.id
        );
        return itemId === revealedMenuItemId;
      })
    );
  }, [revealedMenuItemId, threads]);
  const teamVisibleCount = Math.max(
    requestedTeamVisibleCount,
    revealedThreadIndex + 1
  );
  const visibleThreads = useMemo(
    () => threads.slice(0, teamVisibleCount),
    [teamVisibleCount, threads]
  );
  const resetCloudTeamPagination = useCallback(() => {
    setTeamPagination((current) =>
      resetScopedSectionPagination(current, CLOUD_SESSION_SECTION_PAGE_SIZE)
    );
  }, []);

  // Imported teammate replays materialize a local read-only cache row. Hide
  // only those caches from My Sessions; writable local sessions never move
  // into Team Conversations.
  const cloudFlatListExcludedSessionIds = useMemo(() => {
    if (!orgId) return new Set<string>();
    return collectCloudFlatListExcludedSessionIds(sessions, orgId);
  }, [orgId, sessions]);

  const selectedCloudMenuItemId = useMemo(() => {
    if (!orgId || !activeSessionId) return null;
    const active = sessions.find(
      (session) => session.session_id === activeSessionId
    );
    const imported = active?.importedFrom;
    if (!imported || imported.orgId !== orgId) return null;
    const sourceRow = visibleThreads
      .flatMap((thread) => [thread.root, ...thread.descendants])
      .map((threadRow) => threadRow.row)
      .find(
        (row) =>
          !row.deletedAt && row.sourceSessionId === imported.sourceSessionId
      );
    return sourceRow ? buildCloudRemoteItemId(orgId, sourceRow.id) : null;
  }, [activeSessionId, orgId, sessions, visibleThreads]);

  const findRow = useCallback(
    (rowId: string): RemoteTeammateSessionMetadata | undefined =>
      rows.find((row) => row.id === rowId),
    [rows]
  );

  const runReplay = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      void replaySession(row);
    },
    [replaySession]
  );

  const runFork = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      void forkSession(row);
    },
    [forkSession]
  );

  const handleAutoReplaySkip = useCallback(
    (reason: CloudAutoReplaySkipReason) => {
      Message.error(
        reason === "not-found"
          ? t("cloud.sessionRef.sessionNotFound")
          : t("cloud.sidebar.notPublished")
      );
    },
    [t]
  );

  useCloudSessionAutoReplayReveal({
    orgId,
    rows,
    state,
    fetchedAt,
    busySessionRowId,
    selfUserId,
    localOwnSessionIds,
    refresh,
    runReplay,
    onSkip: handleAutoReplaySkip,
  });

  const handleCloudSessionItemClick = useCallback(
    (item: NavigationMenuItem): boolean => {
      if (item.id === CLOUD_TEAM_SESSIONS_LOAD_MORE_ID) {
        setTeamPagination((current) => ({
          scopeKey: teamPaginationScopeKey,
          visibleCount:
            (current.scopeKey === teamPaginationScopeKey
              ? current.visibleCount
              : CLOUD_SESSION_SECTION_PAGE_SIZE) +
            CLOUD_SESSION_SECTION_PAGE_SIZE,
        }));
        return true;
      }
      const parsed = parseCloudRemoteItemId(item.id);
      if (!parsed) return false;
      const row = findRow(parsed.rowId);
      // Busy / unpublished / vanished rows swallow the click (no-op).
      if (!row || busySessionRowId || row.eventsEpoch === undefined) {
        return true;
      }
      runReplay(row);
      return true;
    },
    [busySessionRowId, findRow, runReplay, teamPaginationScopeKey]
  );

  const hideRemoteSession = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      const importedCopies = sessions.filter(
        (session) =>
          session.importedFrom?.orgId === row.orgId &&
          session.importedFrom.sourceSessionId === row.sourceSessionId
      );
      void Promise.all(
        importedCopies.map(async (session) => {
          try {
            await deleteOrgtrackCollaborationSession(session.session_id);
          } catch {
            // Derived blame rows are best-effort cleanup; the session cache
            // deletion below remains the user's primary hide action.
          }
          try {
            await deleteLocalSession(session.session_id);
            removeSession(session.session_id);
          } catch {
            // Hiding the remote row remains useful even when a stale local
            // cache was already removed by another path.
          }
        })
      );
      setHiddenRemoteSessionIds((current) => {
        const next = new Set(current);
        next.add(hiddenRemoteSessionKey(row.orgId, row.id));
        localStorage.setItem(
          HIDDEN_REMOTE_SESSIONS_STORAGE_KEY,
          JSON.stringify([...next])
        );
        return next;
      });
    },
    [sessions]
  );

  const handleCloudRemoteItemRemove = useCallback(
    (item: NavigationMenuItem): boolean => {
      const parsed = parseCloudRemoteItemId(item.id);
      if (!parsed) return false;
      const row = findRow(parsed.rowId);
      if (row) hideRemoteSession(row);
      return true;
    },
    [findRow, hideRemoteSession]
  );

  const buildRowItem = useCloudSessionRowItemBuilder({
    presenceMap,
    selfUserId,
    t,
    tCommon,
    runFork,
    hideRemoteSession,
  });

  const cloudMenuItems = useCloudTeamSessionMenuItems({
    orgId,
    threads,
    visibleThreads,
    state,
    filter,
    memberMenu,
    setMemberMenu,
    refreshSpinClass,
    handleRefreshClick,
    buildRowItem,
    t,
    tCommon,
  });

  const { cloudRemoteRowMap, cloudRemoteViewerMap } = useCloudRemoteRowMaps({
    visibleThreads,
    presenceMap,
    selfUserId,
  });

  const cloudMemberFilterDropdown = useCloudMemberFilterDropdown({
    orgId,
    filter,
    memberMenu,
    setMemberMenu,
    rows,
    rosterMembers,
    hiddenRemoteSessionIds,
    setHiddenRemoteSessionIds,
    presenceMap,
    onFilterChange,
    t,
  });

  return {
    cloudMenuItems,
    cloudFlatListExcludedSessionIds,
    cloudLocalSessionIds,
    selectedCloudMenuItemId,
    handleCloudSessionItemClick,
    resetCloudTeamPagination,
    handleCloudRemoteItemRemove,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
    cloudRemoteViewerMap,
  };
}
