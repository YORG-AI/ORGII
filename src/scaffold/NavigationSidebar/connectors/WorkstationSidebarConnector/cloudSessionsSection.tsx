/**
 * Cloud-org "Team sessions" sidebar section (managed ORG2 Cloud scope).
 *
 * Replaces the Cloud Org panel's shared-sessions list: when the sidebar's
 * active scope is a cloud org, teammates' shared sessions render as
 * collapsible fork-threaded groups under a separator-headed section.
 * Threads come from the pure `buildCloudSessionThreads` helper; replay/fork
 * ride `useCloudSessionActions` (the exact panel semantics, extracted).
 *
 * Row identity:
 * - rows that are MINE (bare id matches a local session) use the LOCAL
 *   session id — clicks route through the normal sessionMap path, and the
 *   duplicate is hidden from the flat local list (threaded position wins);
 * - teammate rows get `cloudremote-<orgId>|<rowId>` ids, resolved in
 *   useWorkstationSidebarHandlers BEFORE the sessionMap fallback.
 *
 * Parent-row choice: NavigationMenuParentRow already forwards label clicks
 * to onMenuItemClick, so thread roots stay natively clickable (replay/open).
 * The primitive renders hover rowActions on LEAF rows only, so Replay/Fork
 * hover buttons appear on descendants and on single-row threads (rendered
 * as leaves); a multi-row thread's root keeps click-to-replay but has no
 * hover fork button — no self-duplicate child row is injected.
 */
import { MenuItem, Menu as TauriMenu } from "@tauri-apps/api/menu";
import { useAtomValue } from "jotai";
import {
  Bot,
  Cloud,
  GitFork,
  ListFilter,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { deleteSession as deleteLocalSession } from "@src/api/tauri/agent";
import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import { deleteOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Message from "@src/components/Message";
import {
  buildCloudRemoteItemId,
  includeRevealedCloudRow,
  parseCloudRemoteItemId,
} from "@src/features/Org2Cloud/cloudRemoteItemId";
import {
  type CloudSessionFilter,
  filterCloudSessionRows,
} from "@src/features/Org2Cloud/cloudSessionFilter";
import { resolveSessionTaskCounts } from "@src/features/Org2Cloud/cloudSessionTaskCounts";
import {
  type CloudSessionThreadRow,
  buildCloudSessionThreads,
  collectThreadedLocalSessionIds,
  isCloudThreadRowDisabled,
} from "@src/features/Org2Cloud/cloudSessionThreads";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { cloudSessionIdFromRowId } from "@src/features/Org2Cloud/org2CloudBackendAdapter";
import {
  org2CloudCommentTasksAtom,
  tasksForSession,
} from "@src/features/Org2Cloud/org2CloudCommentTasksAtom";
import {
  org2CloudPresenceAtom,
  viewersForSession,
} from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useCloudSessionActions } from "@src/features/Org2Cloud/useCloudSessionActions";
import { useOpenCloudBilling } from "@src/features/Org2Cloud/useOpenCloudBilling";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";
import { removeSession } from "@src/store/session";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { separator } from "../useSessionMenuItems/menuItemBuilders";

interface UseCloudSessionsSectionParams {
  /** Active cloud org id (bare, not `cloud:`-prefixed); null ⇒ no section. */
  orgId: string | null;
  sessions: readonly Session[];
  /** Active Team-sessions filter (all, directed-to-me, or one owner). */
  filter: CloudSessionFilter;
  /** Currently active local session, used to map replay imports to cloud rows. */
  activeSessionId: string;
  /** One exact Team Session row temporarily revealed by cross-surface nav. */
  revealedMenuItemId?: string;
  onFilterChange: (filter: CloudSessionFilter) => void;
}

interface UseCloudSessionsSectionResult {
  /** Separator + thread rows; empty when no cloud scope is active. */
  cloudMenuItems: NavigationMenuItem[];
  /** Local session ids to hide from the flat list (threaded position wins). */
  cloudThreadedLocalSessionIds: ReadonlySet<string>;
  /** Cloud row key corresponding to the active local replay/import session. */
  selectedCloudMenuItemId: string | null;
  /** Click resolver for `cloudremote-` rows (wired into the handlers hook). */
  handleCloudRemoteItemClick: (item: NavigationMenuItem) => boolean;
  /** Locally hide a teammate cloud row and discard its replay cache. */
  handleCloudRemoteItemRemove: (item: NavigationMenuItem) => boolean;
  /** Member-filter dropdown portal — render once next to the sidebar. */
  cloudMemberFilterDropdown: React.ReactNode;
  /**
   * Teammate row metadata keyed by `cloudremote-` menu item id — feeds the
   * sidebar hover card (local "mine" rows use the session-store card instead).
   */
  cloudRemoteRowMap: ReadonlyMap<string, RemoteTeammateSessionMetadata>;
}

interface MemberFilterMenuState {
  top: number;
  left: number;
}

const HIDDEN_REMOTE_SESSIONS_STORAGE_KEY =
  "orgii:org2-cloud-v1:hidden-remote-sessions";

function readHiddenRemoteSessionIds(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(
      localStorage.getItem(HIDDEN_REMOTE_SESSIONS_STORAGE_KEY) ?? "[]"
    );
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []
    );
  } catch {
    return new Set();
  }
}

function hiddenRemoteSessionKey(orgId: string, rowId: string): string {
  return `${orgId}|${rowId}`;
}

export function useCloudSessionsSection({
  orgId,
  sessions,
  filter,
  activeSessionId,
  revealedMenuItemId,
  onFilterChange,
}: UseCloudSessionsSectionParams): UseCloudSessionsSectionResult {
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const { rows, state, refresh } = useCloudOrgRemoteSessions(orgId);
  const { replaySession, forkSession, busySessionRowId } =
    useCloudSessionActions(orgId);
  const openBilling = useOpenCloudBilling();
  // Engine-fed task map (agent-pickup design §4): read-only here — the
  // section renders whatever the atoms already hold; the 60s sync pass is
  // the only thing that refreshes it. No fetches, no timers.
  const commentTaskMap = useAtomValue(org2CloudCommentTasksAtom);
  const presenceMap = useAtomValue(org2CloudPresenceAtom);
  const selfUserId = useAtomValue(org2CloudAuthAtom)?.userId ?? null;
  const [memberMenu, setMemberMenu] = useState<MemberFilterMenuState | null>(
    null
  );
  const [hiddenRemoteSessionIds, setHiddenRemoteSessionIds] = useState(
    readHiddenRemoteSessionIds
  );

  const localOwnSessionIds = useMemo(
    () => new Set(sessions.map((session) => session.session_id)),
    [sessions]
  );

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

  // Local sessions that already render at their threaded position — hidden
  // from the flat local list so they never appear twice. Invariant: a session
  // is excluded from the flat list only if it is actually VISIBLE in the team
  // section, so this derives from the FILTERED threads — a member filter that
  // drops a thread returns the viewer's own sessions to the flat list instead
  // of vanishing them from both lists.
  //
  // Two kinds of exclusions:
  // 1. MINE rows (bare id = a local session) — the thread row IS the entry.
  // 2. IMPORTED TEAMMATE COPIES (`importedFrom`): a replay click materializes
  //    the transcript as a local `imported-session-…` cache row. That cache
  //    must not ALSO list under TODAY while its team row renders — clicking
  //    the team row re-opens the same import (deterministic id + cursor
  //    no-op), so hiding it removes the "I just looked at it and it
  //    duplicated" effect without losing anything.
  const cloudThreadedLocalSessionIds = useMemo(() => {
    if (!orgId) return new Set<string>();
    const ids = collectThreadedLocalSessionIds(threads);
    const visibleBareIds = new Set<string>();
    for (const thread of threads) {
      for (const threadRow of [thread.root, ...thread.descendants]) {
        visibleBareIds.add(threadRow.bareSessionId);
      }
    }
    for (const session of sessions) {
      const imported = session.importedFrom;
      if (
        imported &&
        imported.orgId === orgId &&
        visibleBareIds.has(imported.sourceSessionId)
      ) {
        ids.add(session.session_id);
      }
    }
    return ids;
  }, [orgId, threads, sessions]);

  const selectedCloudMenuItemId = useMemo(() => {
    if (!orgId || !activeSessionId) return null;
    const active = sessions.find(
      (session) => session.session_id === activeSessionId
    );
    const imported = active?.importedFrom;
    if (!imported || imported.orgId !== orgId) return null;
    const sourceRow = visibleRows.find(
      (row) =>
        !row.deletedAt &&
        cloudSessionIdFromRowId(row.id) === imported.sourceSessionId
    );
    return sourceRow ? buildCloudRemoteItemId(orgId, sourceRow.id) : null;
  }, [activeSessionId, orgId, sessions, visibleRows]);

  const findRow = useCallback(
    (rowId: string): RemoteTeammateSessionMetadata | undefined =>
      rows.find((row) => row.id === rowId),
    [rows]
  );

  const runReplay = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      void replaySession(row).then((outcome) => {
        if (outcome === "retention-expired") {
          Message.error(t("cloud.orgPanel.retentionUpgrade"), {
            cancel: {
              label: t("cloud.orgPanel.upgrade"),
              onClick: openBilling,
            },
          });
        }
      });
    },
    [replaySession, t, openBilling]
  );

  const runFork = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      void forkSession(row).then((outcome) => {
        if (outcome === "retention-expired") {
          Message.error(t("cloud.orgPanel.retentionUpgrade"), {
            cancel: {
              label: t("cloud.orgPanel.upgrade"),
              onClick: openBilling,
            },
          });
        }
      });
    },
    [forkSession, t, openBilling]
  );

  const handleCloudRemoteItemClick = useCallback(
    (item: NavigationMenuItem): boolean => {
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
    [busySessionRowId, findRow, runReplay]
  );

  const hideRemoteSession = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      const sourceSessionId = cloudSessionIdFromRowId(row.id);
      const importedCopies = sessions.filter(
        (session) =>
          session.importedFrom?.orgId === row.orgId &&
          session.importedFrom.sourceSessionId === sourceSessionId
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

  const buildRowItem = useCallback(
    (threadRow: CloudSessionThreadRow, asParentOf?: NavigationMenuItem[]) => {
      const { row, bareSessionId, isMine, isOrphan } = threadRow;
      const isFork = Boolean(row.forkedFrom);
      // Mine rows route to the LOCAL session and need no published segments —
      // only teammate rows require an events epoch to be clickable (the
      // connector's "not published" title tooltip keys on this too).
      const disabled = isCloudThreadRowDisabled(threadRow);
      const itemId = isMine
        ? bareSessionId
        : buildCloudRemoteItemId(row.orgId, row.id);
      const relativeTime = row.lastActivityAt
        ? formatRelativeTime(row.lastActivityAt, "nano")
        : "";
      const externalSourceId =
        row.origin?.kind === "external_history" ? row.origin.source : undefined;
      const originLabel = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
        (source) => source.sourceId === externalSourceId
      )?.displayName;
      const ownerAndTime = [
        originLabel,
        `@${row.ownerDisplayName}`,
        row.forkedFrom?.ownerDisplayName
          ? t("cloud.sidebar.forkedFrom", {
              name: row.forkedFrom.ownerDisplayName,
            })
          : null,
        relativeTime,
      ]
        .filter(Boolean)
        .join(" · ");
      // Unresolved session-comment threads (0014 listing counters): a small
      // count chip in the trailing accessory slot. On LEAF rows the slot
      // fades on hover to reveal the Replay/Fork actions (platform
      // pattern); thread-root parent rows keep it visible.
      // Suppress the unresolved-comment badge on rows the viewer cannot open:
      // a disabled teammate metadata_only row (eventsEpoch === undefined) has
      // no reachable notes surface — clicking is a no-op — so advertising a
      // count the viewer can neither read nor resolve is a pure dead end.
      const unresolvedComments = disabled
        ? 0
        : (row.unresolvedCommentCount ?? 0);
      const commentsBadge =
        unresolvedComments > 0 ? (
          <span
            data-testid="session-comments-badge"
            aria-label={t("cloud.comments.unresolvedBadge", {
              count: unresolvedComments,
            })}
            className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary-6 px-1 text-[9px] font-medium leading-none text-white"
          >
            {unresolvedComments}
          </span>
        ) : undefined;
      // Agent-task dual chips (0002 listing counters; agent-pickup design
      // §4 UI item 6) next to the comments badge. Per-row server counters
      // are primary; the engine-fed task map is the cross-scope fallback
      // for pre-0002 backends that omit both keys. Both chips share the
      // `session-tasks-badge` testid, split by `data-variant`.
      const taskCounts = resolveSessionTaskCounts(
        row,
        tasksForSession(commentTaskMap, row.orgId, bareSessionId)
      );
      const openTasksLabel = t("cloud.comments.task.openBadge", {
        count: taskCounts.open,
        defaultValue_one: "{{count}} agent task awaiting pickup",
        defaultValue_other: "{{count}} agent tasks awaiting pickup",
      });
      const openTasksChip =
        taskCounts.open > 0 ? (
          <span
            data-testid="session-tasks-badge"
            data-variant="attention"
            data-count={taskCounts.open}
            aria-label={openTasksLabel}
            title={openTasksLabel}
            className="inline-flex h-3.5 min-w-3.5 items-center justify-center gap-0.5 rounded-full bg-warning-6 px-1 text-[9px] font-medium leading-none text-white"
          >
            <Bot size={9} strokeWidth={2.5} />
            {taskCounts.open}
          </span>
        ) : undefined;
      const activeTasksLabel = t("cloud.comments.task.activeBadge", {
        count: taskCounts.active,
        defaultValue_one: "an agent is working on this session",
        defaultValue_other: "{{count}} agents are working on this session",
      });
      // Subtle pulse, no number: "an agent is working" is presence, not a
      // count the viewer must act on (the attention chip carries counts).
      const activeTasksChip =
        taskCounts.active > 0 ? (
          <span
            data-testid="session-tasks-badge"
            data-variant="active"
            data-count={taskCounts.active}
            aria-label={activeTasksLabel}
            title={activeTasksLabel}
            className="inline-flex h-3.5 items-center justify-center text-primary-6 motion-safe:animate-pulse motion-reduce:opacity-80"
          >
            <Bot size={11} strokeWidth={2} />
          </span>
        ) : undefined;
      // Live viewers: other org members currently viewing this session.
      const viewers = viewersForSession(
        presenceMap,
        row.orgId,
        bareSessionId,
        selfUserId
      );
      const overflowViewers = viewers.slice(3);
      const viewerChips =
        viewers.length > 0 ? (
          <span className="inline-flex items-center -space-x-1">
            {viewers.slice(0, 3).map((viewer) => (
              <span
                key={viewer.userId}
                data-testid="session-viewer-chip"
                aria-label={t("cloud.sidebar.viewerTooltip", {
                  name: viewer.displayName,
                })}
                title={t("cloud.sidebar.viewerTooltip", {
                  name: viewer.displayName,
                })}
                className="inline-flex size-3.5 items-center justify-center rounded-full bg-success-6 text-[8px] font-semibold leading-none text-white ring-1 ring-bg-1"
              >
                {(viewer.displayName || "?").slice(0, 1).toUpperCase()}
              </span>
            ))}
            {overflowViewers.length > 0 && (
              <span
                data-testid="session-viewer-overflow"
                title={`${t("cloud.sidebar.viewerOverflow", {
                  count: overflowViewers.length,
                })}\n${overflowViewers
                  .map((viewer) => viewer.displayName)
                  .join(", ")}`}
                className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-fill-3 px-0.5 text-[8px] font-semibold leading-none text-text-2 ring-1 ring-bg-1"
              >
                +{overflowViewers.length}
              </span>
            )}
          </span>
        ) : undefined;
      const trailingElement =
        viewerChips || commentsBadge || openTasksChip || activeTasksChip ? (
          <span className="inline-flex items-center gap-1">
            {viewerChips}
            {commentsBadge}
            {openTasksChip}
            {activeTasksChip}
          </span>
        ) : undefined;
      // Strip fork glyph(s) baked into pushed titles; the GitFork icon carries provenance.
      const displayTitle = row.title.replace(/^(?:⑂\s*)+/u, "");
      const item: NavigationMenuItem = {
        id: itemId,
        key: itemId,
        label: displayTitle,
        searchText: `${displayTitle} ${row.ownerDisplayName}`,
        dataTestId: `sidebar-cloud-session-item-${bareSessionId}`,
        icon: isFork ? GitFork : Cloud,
        shortcut: ownerAndTime,
        // Root aged out of the retention window — attribute the fork inline.
        // No parent display name ⇒ omit the sublabel entirely (falling back
        // to the fork's OWN owner would mis-attribute the parent).
        subtitle:
          isOrphan && row.forkedFrom?.ownerDisplayName
            ? t("cloud.sidebar.forkedFrom", {
                name: row.forkedFrom.ownerDisplayName,
              })
            : undefined,
        trailingElement,
        disabled,
        children: asParentOf,
      };
      if (!disabled) {
        item.showMoreActions = true;
      }
      if (!isMine && !disabled) {
        // Teammate rows open/replay on plain click. Hover adds Fork plus the
        // standard overflow menu, whether this row is a leaf or thread root.
        item.rowActions = [
          {
            icon: GitFork,
            label: t("cloud.orgPanel.fork"),
            onClick: () => runFork(row),
          },
          {
            icon: MoreHorizontal,
            label: tCommon("actions.more"),
            onClick: () => {
              void MenuItem.new({
                text: tCommon("actions.remove", "Remove"),
                action: () => hideRemoteSession(row),
              }).then(async (removeItem) => {
                const menu = await TauriMenu.new({ items: [removeItem] });
                await menu.popup();
              });
            },
          },
        ];
      }
      return item;
    },
    [
      commentTaskMap,
      hideRemoteSession,
      presenceMap,
      runFork,
      selfUserId,
      t,
      tCommon,
    ]
  );

  const cloudMenuItems = useMemo<NavigationMenuItem[]>(() => {
    if (!orgId) return [];
    const header = separator(
      "cloud-team-sessions",
      t("cloud.sidebar.teamSessions")
    );
    header.rowActions = [
      {
        icon: RefreshCw,
        label: tCommon("actions.refresh"),
        dataTestId: "cloud-team-sessions-refresh",
        onClick: () => refresh(),
      },
      {
        icon: ListFilter,
        label: t("cloud.sidebar.sessionFilter"),
        active: filter.kind !== "all",
        dataTestId: "cloud-team-sessions-filter",
        onClick: (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMemberMenu((current) =>
            current ? null : { top: rect.bottom + 4, left: rect.left }
          );
        },
      },
    ];
    const items: NavigationMenuItem[] = [header];
    for (const thread of threads) {
      if (thread.descendants.length === 0) {
        items.push(buildRowItem(thread.root));
      } else {
        items.push(
          buildRowItem(
            thread.root,
            thread.descendants.map((descendant) => buildRowItem(descendant))
          )
        );
      }
    }
    if (threads.length === 0) {
      const emptyLabel =
        state === "error"
          ? t("cloud.orgPanel.sessionsLoadError")
          : state === "ready"
            ? t("cloud.orgPanel.sessionsEmpty")
            : t("cloud.orgPanel.loading");
      items.push({
        id: "cloud-team-sessions-empty",
        key: "cloud-team-sessions-empty",
        label: emptyLabel,
        // Stable E2E hook: the section header is a locale-dependent section
        // title (no testid slot), so this row is the deterministic proof the
        // "Team sessions" section rendered (empty, loading, and error states
        // all funnel here).
        dataTestId: "cloud-team-sessions-empty",
        visualTone: "secondary",
        disabled: true,
      });
    }
    return items;
  }, [orgId, threads, state, filter.kind, refresh, buildRowItem, t, tCommon]);

  // Hover-card lookup: every VISIBLE teammate thread row, keyed by the same
  // `cloudremote-` id the menu item carries. Mine rows are intentionally
  // absent — they resolve through the local session store.
  const cloudRemoteRowMap = useMemo(() => {
    const map = new Map<string, RemoteTeammateSessionMetadata>();
    for (const thread of threads) {
      for (const threadRow of [thread.root, ...thread.descendants]) {
        if (threadRow.isMine) continue;
        map.set(
          buildCloudRemoteItemId(threadRow.row.orgId, threadRow.row.id),
          threadRow.row
        );
      }
    }
    return map;
  }, [threads]);

  // Everyone + distinct owners of the CURRENT rows (value = ownerUserId).
  const memberOptions = useMemo(() => {
    const byUserId = new Map<string, string>();
    for (const row of rows) {
      if (row.deletedAt) continue;
      if (!byUserId.has(row.ownerUserId)) {
        byUserId.set(row.ownerUserId, row.ownerDisplayName);
      }
    }
    return [...byUserId.entries()].map(([userId, displayName]) => ({
      userId,
      displayName,
    }));
  }, [rows]);

  const closeMemberMenu = useCallback(() => setMemberMenu(null), []);
  // Escape dismisses the member-filter panel. Document-level because the
  // panel's rows are DropdownItem divs (not focus targets) — keyboard users
  // must be able to bail without picking an option.
  useEffect(() => {
    if (!memberMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMemberMenu(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [memberMenu]);
  const handleFilterSelect = useCallback(
    (nextFilter: CloudSessionFilter) => {
      onFilterChange(nextFilter);
      setMemberMenu(null);
    },
    [onFilterChange]
  );

  // Rows the viewer hid via the row menu; this dropdown entry is the only way back.
  const hiddenCountForOrg = useMemo(() => {
    if (!orgId) return 0;
    let count = 0;
    for (const key of hiddenRemoteSessionIds) {
      if (key.startsWith(`${orgId}|`)) count += 1;
    }
    return count;
  }, [hiddenRemoteSessionIds, orgId]);
  const handleShowHidden = useCallback(() => {
    if (!orgId) return;
    setHiddenRemoteSessionIds((current) => {
      const next = new Set(
        [...current].filter((key) => !key.startsWith(`${orgId}|`))
      );
      localStorage.setItem(
        HIDDEN_REMOTE_SESSIONS_STORAGE_KEY,
        JSON.stringify([...next])
      );
      return next;
    });
    setMemberMenu(null);
  }, [orgId]);

  // Same DropdownMenu look as SessionFilterButton, but anchored to the
  // section header's action button (rendered by NavigationSidebar), so the
  // panel is positioned from the click target instead of a local triggerRef.
  const cloudMemberFilterDropdown = memberMenu
    ? createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: DROPDOWN_PANEL.zIndex - 1 }}
            onMouseDown={closeMemberMenu}
          />
          <div
            className={`${DROPDOWN_CLASSES.panelAnimated} ${DROPDOWN_WIDTHS.sidebarMenuClass} fixed`}
            style={{ top: memberMenu.top, left: memberMenu.left }}
            data-testid="sidebar-cloud-member-filter"
            // Keyboard focus may be parked in another pane (chat composer /
            // terminal), where the document-level Escape listener never
            // fires. Own the focus while open and handle Escape locally too.
            tabIndex={-1}
            ref={(node) => node?.focus({ preventScroll: true })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeMemberMenu();
              }
            }}
          >
            <div
              className={DROPDOWN_CLASSES.itemsColumnPadded}
              role="listbox"
              aria-label={t("cloud.sidebar.sessionFilter")}
            >
              <div className={DROPDOWN_CLASSES.sectionLabel}>
                {t("cloud.sidebar.sessionFilter")}
              </div>
              {[
                {
                  key: "everyone",
                  filter: { kind: "all" } as CloudSessionFilter,
                  displayName: t("cloud.sidebar.everyone"),
                  userId: null as string | null,
                },
                {
                  key: "directly-shared-with-me",
                  filter: {
                    kind: "directlySharedWithMe",
                  } as CloudSessionFilter,
                  displayName: t("cloud.sidebar.directlySharedWithMe"),
                  userId: null as string | null,
                },
                ...memberOptions.map((option) => ({
                  key: `member-${option.userId}`,
                  filter: {
                    kind: "member",
                    ownerUserId: option.userId,
                  } as CloudSessionFilter,
                  ...option,
                })),
              ].map((option) => {
                const active =
                  option.filter.kind === filter.kind &&
                  (option.filter.kind !== "member" ||
                    (filter.kind === "member" &&
                      option.filter.ownerUserId === filter.ownerUserId));
                const presenceEntry = option.userId
                  ? (orgId ? presenceMap[orgId] : undefined)?.[option.userId]
                  : undefined;
                const viewingRow = presenceEntry?.viewingSessionId
                  ? rows.find(
                      (row) =>
                        cloudSessionIdFromRowId(row.id) ===
                        presenceEntry.viewingSessionId
                    )
                  : undefined;
                const viewingTitle = viewingRow
                  ? viewingRow.title.replace(/^(?:⑂\s*)+/u, "")
                  : undefined;
                return (
                  // DropdownItem carries the option semantics itself
                  // (role="option" + aria-selected + selected check).
                  <DropdownItem
                    key={option.key}
                    dataTestId={`sidebar-cloud-filter-${option.key}`}
                    selected={active}
                    onClick={() => handleFilterSelect(option.filter)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {presenceEntry && (
                          <span
                            data-testid="member-online-dot"
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success-6"
                          />
                        )}
                        <span className="min-w-0 truncate">
                          {option.displayName}
                        </span>
                      </span>
                      {viewingTitle && (
                        <span className="min-w-0 truncate pl-3 text-[10px] text-text-3">
                          {t("cloud.sidebar.memberViewing", {
                            title: viewingTitle,
                          })}
                        </span>
                      )}
                    </span>
                  </DropdownItem>
                );
              })}
              {hiddenCountForOrg > 0 && (
                <>
                  <div className={DROPDOWN_CLASSES.menuSeparator} />
                  <DropdownItem onClick={handleShowHidden}>
                    <span className="min-w-0 truncate">
                      {t("cloud.sidebar.showHidden", {
                        count: hiddenCountForOrg,
                      })}
                    </span>
                  </DropdownItem>
                </>
              )}
            </div>
          </div>
        </>,
        document.body
      )
    : null;

  return {
    cloudMenuItems,
    cloudThreadedLocalSessionIds,
    selectedCloudMenuItemId,
    handleCloudRemoteItemClick,
    handleCloudRemoteItemRemove,
    cloudMemberFilterDropdown,
    cloudRemoteRowMap,
  };
}
