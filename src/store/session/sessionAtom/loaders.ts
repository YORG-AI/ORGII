/**
 * Session Loaders
 *
 * Two complementary loading paths:
 *
 *  - `loadSessions()` — legacy "load everything (with limit/offset)" entry
 *    used by panels that want a single flat list across all categories
 *    (Chat history panel, Simulator panel, useSessionManager).
 *
 *  - `loadSessionRoster()` / `loadMoreCategory()` — the shared incremental
 *    roster consumed by Sidebar and every session Kanban mode. Native
 *    categories fetch one top-N page; imported sources fetch lightweight,
 *    independent date-bucket pages from ORGII's cache so a busy Today bucket
 *    cannot hide Yesterday.
 *
 * Split modules:
 *   loaderShared.ts           — logger, store accessor, FetchPageResult
 *   mergeSessions.ts          — roster merge + pagination patch primitives
 *   importedHistoryPaging.ts  — external-history date-bucket paging
 *   sidebarLoad.ts            — roster generation, category pages, coordinator
 */
import { isImportedHistoryListCategory } from "@src/api/tauri/externalHistory";
import {
  type SessionFilter,
  type SessionListResponse,
  sessionAggregateList,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "../dataSourceConfigAtom";
import {
  sessionErrorAtom,
  sessionFlatListLastLoadedBySignatureAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "./atoms";
import { mergeGuestImportedSessions } from "./guestImportRegistry";
import {
  importedPageHasProgress,
  replaceExternalHistorySourceFirstPage,
} from "./importedHistoryPaging";
import { BULK_CACHE_DURATION_MS, getStore, log } from "./loaderShared";
import {
  type LoadSessionsOptions,
  loadSessionsCacheSignature,
  mergeSessions,
  preserveImportedReplayRows,
  setPaginationFor,
} from "./mergeSessions";
import {
  BASE_SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  type SessionPaginationMap,
  sessionPaginationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import {
  createSidebarLoadCoordinator,
  currentSidebarRosterGeneration,
  exactSessionBatchLoadsForStore,
  loadCategoryPage,
  nextSidebarRosterGeneration,
  performSidebarSessionLoad,
} from "./sidebarLoad";
import {
  sidebarCategoryForSession,
  syncSessionWithNativeRosters,
} from "./sidebarRoster";
import type { Session } from "./types";

const DEFAULT_FLAT_LIST_PAGE_SIZE = 200;
const RECENT_NATIVE_REFRESH_LIMIT =
  SESSION_SIDEBAR_PAGE_SIZE * BASE_SESSION_LIST_CATEGORIES.length;
const recentNativeRefreshesByStore = new WeakMap<object, Promise<void>>();

export const loadSessions = async (options?: LoadSessionsOptions) => {
  const store = getStore();
  const { forceRefresh = false } = options || {};
  const cacheSignature = loadSessionsCacheSignature(options);

  const lastLoaded = store.get(sessionFlatListLastLoadedBySignatureAtom)[
    cacheSignature
  ];
  const now = Date.now();

  if (
    !forceRefresh &&
    lastLoaded &&
    now - lastLoaded < BULK_CACHE_DURATION_MS
  ) {
    return;
  }

  store.set(sessionLoadingAtom, true);
  store.set(sessionErrorAtom, null);

  try {
    const filter: SessionFilter | undefined =
      options?.repoPath ||
      options?.orgId ||
      options?.projectSlug ||
      options?.workItemId ||
      options?.status ||
      options?.limit ||
      options?.offset
        ? {
            repoPath: options?.repoPath,
            orgId: options?.orgId,
            projectSlug: options?.projectSlug,
            workItemId: options?.workItemId,
            status: options?.status,
            limit: options?.limit,
            offset: options?.offset,
          }
        : undefined;

    const disabledSources = Object.entries(store.get(dataSourceConfigAtom))
      .filter(([, cfg]) => cfg?.enabled === false)
      .map(([sourceId]) => sourceId);

    const response = await sessionAggregateList({
      ...filter,
      limit: filter?.limit ?? DEFAULT_FLAT_LIST_PAGE_SIZE,
      includeExternalHistory: store.get(externalSessionsEnabledAtom),
      sortBy: filter?.sortBy ?? "updated_at",
      sortOrder: filter?.sortOrder ?? "desc",
      disabledExternalHistorySources:
        disabledSources.length > 0 ? disabledSources : undefined,
    });

    const fetched: Session[] = mergeGuestImportedSessions(
      toFrontendSessions((response as SessionListResponse).sessions)
    );

    fetched.sort((sessionA, sessionB) =>
      (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
    );

    store.set(sessionsAtom, (prev) =>
      preserveImportedReplayRows(prev, fetched)
    );
    persistSessions(fetched);
    store.set(sessionFlatListLastLoadedBySignatureAtom, (prev) => ({
      ...prev,
      [cacheSignature]: now,
    }));
  } catch (error) {
    log.error("[SessionAtom] Failed to load sessions:", error);
    store.set(
      sessionErrorAtom,
      error instanceof Error ? error.message : "Failed to load sessions"
    );
  } finally {
    store.set(sessionLoadingAtom, false);
  }
};

/**
 * One process-wide session-roster loader. Overlapping mounts/refreshes join the
 * active read; a stronger request (forced or larger page) is merged into one
 * follow-up pass instead of starting a parallel category fan-out.
 */
export const loadSessionRoster = createSidebarLoadCoordinator(
  performSidebarSessionLoad
);

/**
 * Compatibility alias for callers outside the roster surfaces. New Sidebar
 * and Kanban code should use `loadSessionRoster` so ownership is unambiguous.
 */
export const loadSidebarSessions = loadSessionRoster;

/**
 * Refresh only the recent native rows that can be created by gateways and
 * other out-of-process surfaces.
 *
 * The focused sidebar safety poll exists so a `/newsession` command appears
 * without a manual reload. Running the full roster loader for that poll used
 * to fan out across every native category and every imported-history source
 * every 15 seconds. One bounded newest-first native query is sufficient for
 * discovery and preserves the paginated imported rows already in memory.
 */
export function refreshRecentNativeSessions(): Promise<void> {
  const store = getStore();
  const active = recentNativeRefreshesByStore.get(store);
  if (active) return active;

  const previousById = new Map(
    store
      .get(sessionsAtom)
      .map((session) => [session.session_id, session] as const)
  );
  const refresh = (async () => {
    const response = await sessionAggregateList({
      includeExternalHistory: false,
      limit: RECENT_NATIVE_REFRESH_LIMIT,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    const incoming = toFrontendSessions(response.sessions).filter(
      isPrimarySessionListSession
    );
    let merged: Session[] = [];
    store.set(sessionsAtom, (previous) => {
      merged = mergeSessions(previous, incoming);
      return merged;
    });
    const membershipChanges = incoming.filter((session) => {
      const previous = previousById.get(session.session_id);
      return (
        !previous ||
        sidebarCategoryForSession(previous) !==
          sidebarCategoryForSession(session)
      );
    });
    if (membershipChanges.length > 0) {
      store.set(sessionPaginationAtom, (previous) =>
        membershipChanges.reduce(
          (pagination, session) =>
            syncSessionWithNativeRosters(pagination, session),
          previous
        )
      );
    }
    persistSessions(merged);
  })().finally(() => {
    if (recentNativeRefreshesByStore.get(store) === refresh) {
      recentNativeRefreshesByStore.delete(store);
    }
  });
  recentNativeRefreshesByStore.set(store, refresh);
  return refresh;
}

/**
 * Hydrate canonical session rows by exact id.
 *
 * Normal sidebar loading is intentionally paginated per source/date bucket.
 * Deep links and cloud-scoped My Conversations can target much older rows, so
 * walking pages would be slow and nondeterministic. The aggregate API resolves
 * the exact ids in one bounded batch and merges only authoritative rows.
 */
export function loadSidebarSessionsByIds(
  sessionIds: readonly string[]
): Promise<Session[]> {
  const normalizedSessionIds = [
    ...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
  ];
  if (normalizedSessionIds.length === 0) return Promise.resolve([]);

  const store = getStore();
  const exactSessionBatchLoads = exactSessionBatchLoadsForStore(store);
  // React effects and deep-link reveals can converge on the same exact rows.
  // Share that batch while it is active; entries are removed on settlement so
  // this coordinator cannot grow over the app lifetime.
  const requestKey = JSON.stringify([...normalizedSessionIds].sort());
  const existing = exactSessionBatchLoads.get(requestKey);
  if (existing) return existing;

  const request = (async (): Promise<Session[]> => {
    const response = await sessionAggregateList({
      sessionIds: normalizedSessionIds,
      includeExternalHistory: store.get(externalSessionsEnabledAtom),
      limit: normalizedSessionIds.length,
    });
    const requestedIds = new Set(normalizedSessionIds);
    const loaded = toFrontendSessions(response.sessions).filter((candidate) =>
      requestedIds.has(candidate.session_id)
    );
    if (loaded.length === 0) return [];

    store.set(sessionsAtom, (previous) => mergeSessions(previous, loaded));
    persistSessions(store.get(sessionsAtom));
    return loaded;
  })();
  const trackedRequest = request.finally(() => {
    if (exactSessionBatchLoads.get(requestKey) === trackedRequest) {
      exactSessionBatchLoads.delete(requestKey);
    }
  });
  exactSessionBatchLoads.set(requestKey, trackedRequest);
  return trackedRequest;
}

export const loadSidebarSessionById = async (
  sessionId: string
): Promise<Session | null> => {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;

  // Do not return an existing atom row before resolving the canonical record.
  // Transcript activation can insert a lightweight row first; imported
  // subagent rows in particular need the provider cache's parentSessionId so
  // the sidebar can place them beneath the root session deterministically.
  const loaded = await loadSidebarSessionsByIds([normalizedSessionId]);
  return (
    loaded.find((session) => session.session_id === normalizedSessionId) ?? null
  );
};

export interface SidebarPageLoadResult {
  category: SessionListCategory;
  phase: SessionPaginationMap[SessionListCategory]["phase"];
  newSessionIds: readonly string[];
  sessions: readonly Session[];
}

export const loadMoreCategory = async (
  category: SessionListCategory,
  pageSize: number = SESSION_SIDEBAR_PAGE_SIZE
): Promise<SidebarPageLoadResult> => {
  const store = getStore();
  const current = store.get(sessionPaginationAtom)[category];
  if (current.phase === "loading" || current.phase === "exhausted") {
    return {
      category,
      phase: current.phase,
      newSessionIds: [],
      sessions: [],
    };
  }

  const generation =
    currentSidebarRosterGeneration(store) || nextSidebarRosterGeneration(store);
  setPaginationFor(category, { phase: "loading" });

  try {
    const { sessions, hasMore, nextCursor, dateBuckets } =
      await loadCategoryPage(
        category,
        current.cursor,
        pageSize,
        current.dateBuckets
      );
    if (generation !== currentSidebarRosterGeneration(store)) {
      return {
        category,
        phase: store.get(sessionPaginationAtom)[category].phase,
        newSessionIds: [],
        sessions: [],
      };
    }
    const primarySessions = sessions.filter(isPrimarySessionListSession);
    const returnedIds = [
      ...new Set(primarySessions.map((session) => session.session_id)),
    ];
    const imported = isImportedHistoryListCategory(category);
    const replacingFirstPage =
      current.phase === "error" &&
      (imported
        ? !importedPageHasProgress(current.dateBuckets)
        : current.cursor === null);
    const previousIds = new Set(current.sessionIds);
    const newSessionIds = replacingFirstPage
      ? returnedIds
      : returnedIds.filter((sessionId) => !previousIds.has(sessionId));
    if (
      !replacingFirstPage &&
      returnedIds.length > 0 &&
      newSessionIds.length === 0
    ) {
      throw new Error(
        `${category} pagination returned no new roster IDs; cursor was not advanced`
      );
    }
    if (hasMore && returnedIds.length === 0) {
      throw new Error(
        `${category} pagination returned hasMore without roster IDs`
      );
    }
    const sessionIds = replacingFirstPage
      ? returnedIds
      : [...current.sessionIds, ...newSessionIds];
    store.set(sessionsAtom, (prev) => mergeSessions(prev, primarySessions));
    setPaginationFor(category, {
      sessionIds,
      cursor: imported ? null : (nextCursor ?? current.cursor),
      phase: hasMore ? "ready" : "exhausted",
      generation,
      dateBuckets,
    });
    persistSessions(store.get(sessionsAtom));
    const newIds = new Set(newSessionIds);
    return {
      category,
      phase: hasMore ? "ready" : "exhausted",
      newSessionIds,
      sessions: primarySessions.filter((session) =>
        newIds.has(session.session_id)
      ),
    };
  } catch (error) {
    log.warn(`[SessionAtom] loadMoreCategory(${category}) failed:`, error);
    if (generation === currentSidebarRosterGeneration(store)) {
      setPaginationFor(category, { phase: "error", generation });
    }
    return {
      category,
      phase: "error",
      newSessionIds: [],
      sessions: [],
    };
  }
};

export function syncSidebarSessionRoster(session: Session): void {
  const store = getStore();
  store.set(sessionPaginationAtom, (previous) =>
    syncSessionWithNativeRosters(previous, session)
  );
}

/**
 * Register a locally-created native session before the next roster read.
 * Unlike status/pin projections, creation is a membership change and must
 * remain visible even while the sidebar's first page is still loading.
 */
export function registerNewNativeSidebarSession(session: Session): void {
  if (!isPrimarySessionListSession(session)) return;
  const store = getStore();
  store.set(sessionPaginationAtom, (previous) =>
    syncSessionWithNativeRosters(previous, session, {
      registerBeforeInitialPage: true,
    })
  );
}

export const __TESTS_ONLY = {
  createSidebarLoadCoordinator,
  mergeSessions,
  replaceExternalHistorySourceFirstPage,
};
