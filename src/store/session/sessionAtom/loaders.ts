/**
 * Session Loaders
 *
 * Two complementary loading paths:
 *
 *  - `loadSessions()` — legacy "load everything (with limit/offset)" entry
 *    used by panels that want a single flat list across all categories
 *    (Chat history panel, Simulator panel, useSessionManager).
 *
 *  - `loadSidebarSessions()` / `loadMoreCategory()` — sidebar-specific
 *    paginated loaders. Each category/source fetches its own top-N page so a
 *    heavy user with thousands of CLI/imported sessions doesn't pay for the
 *    long tail just to render the most-recent rows.
 */
import {
  IMPORTED_HISTORY_SOURCES,
  type ImportedHistorySource,
  getImportedHistorySourceByListCategory,
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
  isImportedHistorySourceSession,
} from "@src/api/tauri/externalHistory";
import {
  type SessionFilter,
  type SessionListResponse,
  sessionAggregateList,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  sessionErrorAtom,
  sessionFlatListLastLoadedBySignatureAtom,
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "./atoms";
import {
  BASE_SESSION_LIST_CATEGORIES,
  SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  type SessionPaginationMap,
  resetPaginationState,
  sessionPaginationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import type { Session, SessionStatus } from "./types";

const log = createLogger("SessionAtom");

const getStore = () => getInstrumentedStore();
const BULK_CACHE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_FLAT_LIST_PAGE_SIZE = 200;

interface LoadSessionsOptions {
  repoPath?: string;
  orgId?: string;
  projectSlug?: string;
  workItemId?: string;
  status?: SessionStatus;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}

function loadSessionsCacheSignature(options?: LoadSessionsOptions): string {
  return [
    options?.repoPath ?? "",
    options?.orgId ?? "",
    options?.projectSlug ?? "",
    options?.workItemId ?? "",
    options?.status ?? "",
    options?.limit ?? "",
    options?.offset ?? "",
  ].join("\u001f");
}

function mergeSessions(
  prev: readonly Session[],
  incoming: readonly Session[]
): Session[] {
  if (incoming.length === 0) return prev.slice();
  const incomingMap = new Map(
    incoming.map((session) => [session.session_id, session])
  );
  const merged: Session[] = prev.map(
    (session) => incomingMap.get(session.session_id) ?? session
  );
  const seen = new Set(merged.map((session) => session.session_id));
  for (const session of incoming) {
    if (!seen.has(session.session_id)) {
      merged.push(session);
      seen.add(session.session_id);
    }
  }
  merged.sort((sessionA, sessionB) =>
    (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
  );
  return merged;
}

function replaceImportedFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  predicate: (sessionId: string) => boolean
): Session[] {
  const retained = prev.filter((session) => !predicate(session.session_id));
  return mergeSessions(retained, incoming);
}

function replaceExternalHistorySourceFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  source: ImportedHistorySource
): Session[] {
  return replaceImportedFirstPage(prev, incoming, (sessionId) =>
    isImportedHistorySourceSession(sessionId, source)
  );
}

function replaceAllImportedHistoryFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[]
): Session[] {
  return replaceImportedFirstPage(prev, incoming, (sessionId) =>
    Boolean(getImportedHistorySourceBySessionId(sessionId))
  );
}

function setPaginationFor(
  category: SessionListCategory,
  patch: Partial<SessionPaginationMap[SessionListCategory]>
) {
  const store = getStore();
  store.set(sessionPaginationAtom, (prev) => ({
    ...prev,
    [category]: { ...prev[category], ...patch },
  }));
}

async function loadImportedHistorySourcePage(
  source: ImportedHistorySource,
  offset: number,
  pageSize: number
): Promise<FetchPageResult> {
  const effectivePageSize = source.sidebarPageSize
    ? Math.max(pageSize, source.sidebarPageSize)
    : pageSize;
  const response = await sessionAggregateList({
    category: "external_history",
    externalHistorySource: source.sourceId,
    includeExternalHistory: true,
    includeStats: false,
    limit: effectivePageSize + 1,
    offset,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
  const sessions = toFrontendSessions(response.sessions)
    .filter(isPrimarySessionListSession)
    .slice(0, effectivePageSize);
  return {
    sessions,
    hasMore: response.sessions.length > effectivePageSize,
  };
}

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

    const response = await sessionAggregateList({
      ...filter,
      limit: filter?.limit ?? DEFAULT_FLAT_LIST_PAGE_SIZE,
      includeExternalHistory: true,
      includeStats: false,
      sortBy: filter?.sortBy ?? "updated_at",
      sortOrder: filter?.sortOrder ?? "desc",
    });

    const fetched: Session[] = toFrontendSessions(
      (response as SessionListResponse).sessions
    );

    fetched.sort((sessionA, sessionB) =>
      (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
    );

    store.set(sessionsAtom, fetched);
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

interface FetchPageResult {
  sessions: Session[];
  hasMore: boolean;
}

async function fetchAggregatePage(
  wireCategory: "cli" | "agent",
  offset: number,
  pageSize: number
): Promise<FetchPageResult> {
  const response = await sessionAggregateList({
    category: wireCategory,
    includeExternalHistory: false,
    includeStats: false,
    limit: pageSize + 1,
    offset,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
  const primarySessions = toFrontendSessions(response.sessions)
    .filter(isPrimarySessionListSession)
    .slice(0, pageSize);
  return {
    sessions: primarySessions,
    hasMore: response.sessions.length > pageSize,
  };
}

async function fetchExternalHistoryPage(
  offset: number,
  pageSize: number
): Promise<FetchPageResult> {
  const response = await sessionAggregateList({
    category: "external_history",
    includeExternalHistory: true,
    includeStats: false,
    limit: pageSize + 1,
    offset,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
  const sessions = toFrontendSessions(response.sessions)
    .filter(isPrimarySessionListSession)
    .slice(0, pageSize);
  return {
    sessions,
    hasMore: response.sessions.length > pageSize,
  };
}

async function loadCategoryPage(
  category: SessionListCategory,
  offset: number,
  pageSize: number
): Promise<FetchPageResult> {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    if (!source) return { sessions: [], hasMore: false };
    return loadImportedHistorySourcePage(source, offset, pageSize);
  }

  switch (category) {
    case "cli_agent":
      return fetchAggregatePage("cli", offset, pageSize);
    case "rust_agent":
      return fetchAggregatePage("agent", offset, pageSize);
  }
}

function replaceFirstPageForCategory(
  category: SessionListCategory,
  prev: readonly Session[],
  incoming: readonly Session[]
): Session[] {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    return source
      ? replaceExternalHistorySourceFirstPage(prev, incoming, source)
      : mergeSessions(prev, incoming);
  }
  return mergeSessions(prev, incoming);
}

export const loadSidebarSessions = async (options?: {
  pageSize?: number;
  forceRefresh?: boolean;
}) => {
  const store = getStore();
  const pageSize = options?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const { forceRefresh = false } = options ?? {};

  const lastLoaded = store.get(sessionLastLoadedAtom);
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
  store.set(sessionPaginationAtom, resetPaginationState());

  for (const category of SESSION_LIST_CATEGORIES) {
    setPaginationFor(category, { loading: true });
  }

  await Promise.allSettled(
    BASE_SESSION_LIST_CATEGORIES.map(async (category) => {
      try {
        const { sessions, hasMore } = await loadCategoryPage(
          category,
          0,
          pageSize
        );
        store.set(sessionsAtom, (prev) =>
          replaceFirstPageForCategory(category, prev, sessions)
        );
        setPaginationFor(category, {
          loaded: sessions.length,
          hasMore,
          loading: false,
        });
      } catch (error) {
        log.warn(`[SessionAtom] ${category} initial page failed:`, error);
        setPaginationFor(category, { loading: false });
      }
    })
  );

  try {
    const { sessions: externalSessions, hasMore: externalHasMore } =
      await fetchExternalHistoryPage(0, pageSize);
    store.set(sessionsAtom, (prev) =>
      replaceAllImportedHistoryFirstPage(prev, externalSessions)
    );

    const sessionsBySource = new Map<ImportedHistorySource, Session[]>();
    for (const session of externalSessions) {
      const source = getImportedHistorySourceBySessionId(session.session_id);
      if (!source) continue;
      const sourceSessions = sessionsBySource.get(source) ?? [];
      sourceSessions.push(session);
      sessionsBySource.set(source, sourceSessions);
    }

    for (const source of IMPORTED_HISTORY_SOURCES) {
      const sourceSessions = sessionsBySource.get(source) ?? [];
      setPaginationFor(source.listCategory, {
        loaded: sourceSessions.length,
        hasMore: externalHasMore || sourceSessions.length >= pageSize,
        loading: false,
      });
    }
  } catch (error) {
    log.warn("[SessionAtom] external history initial page failed:", error);
    for (const source of IMPORTED_HISTORY_SOURCES) {
      setPaginationFor(source.listCategory, { loading: false });
    }
  }

  const merged = store.get(sessionsAtom);
  persistSessions(merged);
  store.set(sessionLastLoadedAtom, now);
  store.set(sessionLoadingAtom, false);
};

export const loadMoreCategory = async (
  category: SessionListCategory,
  pageSize: number = SESSION_SIDEBAR_PAGE_SIZE
) => {
  const store = getStore();
  const current = store.get(sessionPaginationAtom)[category];
  if (current.loading || !current.hasMore) return;

  setPaginationFor(category, { loading: true });

  try {
    const { sessions, hasMore } = await loadCategoryPage(
      category,
      current.loaded,
      pageSize
    );
    const primarySessions = sessions.filter(isPrimarySessionListSession);
    store.set(sessionsAtom, (prev) => mergeSessions(prev, primarySessions));
    setPaginationFor(category, {
      loaded: current.loaded + sessions.length,
      hasMore,
      loading: false,
    });
    persistSessions(store.get(sessionsAtom));
  } catch (error) {
    log.warn(`[SessionAtom] loadMoreCategory(${category}) failed:`, error);
    setPaginationFor(category, { loading: false });
  }
};

export const __TESTS_ONLY = {
  mergeSessions,
  replaceAllImportedHistoryFirstPage,
  replaceExternalHistorySourceFirstPage,
};
