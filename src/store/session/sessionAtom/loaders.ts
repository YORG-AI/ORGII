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
 *    paginated loaders. Native categories fetch one top-N page; imported
 *    sources fetch lightweight, independent date-bucket pages from ORGII's
 *    cache so a busy Today bucket cannot hide Yesterday.
 */
import {
  type ImportedHistorySource,
  getImportedHistorySourceByListCategory,
  isImportedHistoryListCategory,
  isImportedHistorySourceSession,
} from "@src/api/tauri/externalHistory";
import {
  type ExternalHistorySidebarResponse,
  type ExternalHistorySidebarSourceRequest,
  type SessionFilter,
  type SessionListResponse,
  externalHistorySidebarList,
  sessionAggregateList,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  SESSION_DATE_BUCKET_KEYS,
  getSessionDateBucketRanges,
} from "@src/util/session/sessionDateBuckets";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
  isSourceDisabled,
} from "../dataSourceConfigAtom";
import {
  sessionErrorAtom,
  sessionFlatListLastLoadedBySignatureAtom,
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "./atoms";
import { mergeGuestImportedSessions } from "./guestImportRegistry";
import {
  type DateBucketPaginationMap,
  SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  type SessionPaginationMap,
  emptyDateBucketPagination,
  resetPaginationState,
  sessionPaginationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import type { Session, SessionStatus } from "./types";

const log = createLogger("SessionAtom");

const getStore = () => getInstrumentedStore();
type SessionStore = ReturnType<typeof getStore>;

const BULK_CACHE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_FLAT_LIST_PAGE_SIZE = 200;
interface SidebarLoadFlight {
  scopeKey: string;
  promise: Promise<void>;
}
const sidebarLoadInFlightByStore = new WeakMap<
  SessionStore,
  SidebarLoadFlight
>();

interface FlatLoadFlight {
  scopeKey: string;
  forceRefresh: boolean;
  generation: number;
  promise: Promise<void>;
}

interface FlatLoadState {
  generation: number;
  flight?: FlatLoadFlight;
}

const flatLoadStateByStore = new WeakMap<SessionStore, FlatLoadState>();

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
    options?.limit ?? DEFAULT_FLAT_LIST_PAGE_SIZE,
    options?.offset ?? 0,
  ].join("\u001f");
}

interface FlatLoadScope {
  cacheSignature: string;
  disabledSources: string[];
  includeExternalHistory: boolean;
  scopeKey: string;
}

function getFlatLoadScope(
  store: SessionStore,
  options?: LoadSessionsOptions
): FlatLoadScope {
  const disabledSources = Object.entries(store.get(dataSourceConfigAtom))
    .filter(([, config]) => config?.enabled === false)
    .map(([sourceId]) => sourceId)
    .sort();
  const includeExternalHistory = store.get(externalSessionsEnabledAtom);
  const filterSignature = loadSessionsCacheSignature(options);
  const scopeKey = JSON.stringify([
    filterSignature,
    includeExternalHistory,
    disabledSources,
  ]);
  return {
    cacheSignature: scopeKey,
    disabledSources,
    includeExternalHistory,
    scopeKey,
  };
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
  shouldReplace: (session: Session) => boolean
): Session[] {
  const retained = prev.filter((session) => !shouldReplace(session));
  return mergeSessions(retained, incoming);
}

function replaceExternalHistorySourceFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  source: ImportedHistorySource,
  preserveChildren = true
): Session[] {
  return replaceImportedFirstPage(
    prev,
    incoming,
    (session) =>
      (!preserveChildren || !session.parentSessionId) &&
      isImportedHistorySourceSession(session.session_id, source)
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
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number
): Promise<FetchPageResult> {
  const pages = await loadImportedHistorySourcePages(
    [{ source, currentBuckets }],
    pageSize
  );
  return (
    pages.get(source.sourceId) ?? {
      sessions: [],
      hasMore: false,
      dateBuckets: currentBuckets ?? emptyDateBucketPagination(),
    }
  );
}

interface ImportedHistoryPageInput {
  source: ImportedHistorySource;
  currentBuckets?: DateBucketPaginationMap;
}

function buildImportedHistorySourceRequest(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number
): ExternalHistorySidebarSourceRequest | null {
  const ranges = getSessionDateBucketRanges();
  const buckets = ranges
    .filter(({ bucket }) => !currentBuckets || currentBuckets[bucket].hasMore)
    .map(({ bucket, startMs, endMs }) => ({
      bucket,
      startMs,
      endMs,
      limit: pageSize,
      offset: currentBuckets?.[bucket].loaded ?? 0,
    }));
  return buckets.length > 0 ? { source: source.sourceId, buckets } : null;
}

function importedHistoryPageResult(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  response: ExternalHistorySidebarResponse
): FetchPageResult {
  const dateBuckets = mergeDateBucketPagination(currentBuckets, response);
  const sessions = response.buckets.flatMap((page) =>
    page.sessions.map((row): Session => {
      const name = row.name.trim() || row.sessionId;
      return {
        session_id: row.sessionId,
        name,
        status: row.status ?? "completed",
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        created_time: row.createdAt,
        updated_time: row.updatedAt,
        category: "external_history",
        readOnly: true,
        is_active: row.isActive ?? false,
        background: false,
        repoPath: row.repoPath,
        storagePath: row.storagePath,
        agentIconId: source.iconId,
        agentDisplayName: source.displayName,
        model: row.model,
        totalTokens: row.totalTokens,
        filesChanged: row.filesChanged,
        linesAdded: row.linesAdded,
        linesRemoved: row.linesRemoved,
        touchedFiles: row.touchedFiles,
      };
    })
  );
  return {
    sessions,
    hasMore: SESSION_DATE_BUCKET_KEYS.some(
      (bucket) => dateBuckets[bucket].hasMore
    ),
    dateBuckets,
  };
}

async function loadImportedHistorySourcePages(
  inputs: readonly ImportedHistoryPageInput[],
  pageSize: number
): Promise<Map<string, FetchPageResult>> {
  const results = new Map<string, FetchPageResult>();
  const pending = inputs.flatMap(({ source, currentBuckets }) => {
    const request = buildImportedHistorySourceRequest(
      source,
      currentBuckets,
      pageSize
    );
    if (!request) {
      results.set(source.sourceId, {
        sessions: [],
        hasMore: false,
        dateBuckets: currentBuckets ?? emptyDateBucketPagination(),
      });
      return [];
    }
    return [{ source, currentBuckets, request }];
  });

  if (pending.length === 0) return results;

  const response = await externalHistorySidebarList({
    requests: pending.map(({ request }) => request),
  });
  const responseBySource = new Map(
    response.sources.map((sourceResponse) => [
      sourceResponse.source,
      sourceResponse,
    ])
  );
  for (const { source, currentBuckets } of pending) {
    const sourceResponse = responseBySource.get(source.sourceId);
    if (!sourceResponse) {
      throw new Error(
        `External history sidebar response omitted ${source.sourceId}`
      );
    }
    results.set(
      source.sourceId,
      importedHistoryPageResult(source, currentBuckets, sourceResponse)
    );
  }
  return results;
}

function mergeDateBucketPagination(
  current: DateBucketPaginationMap | undefined,
  response: ExternalHistorySidebarResponse
): DateBucketPaginationMap {
  const next = { ...(current ?? emptyDateBucketPagination()) };
  for (const page of response.buckets) {
    const previous = next[page.bucket];
    next[page.bucket] = {
      loaded: previous.loaded + page.sessions.length,
      hasMore: page.hasMore,
    };
  }
  return next;
}

async function performFlatSessionLoad(
  store: SessionStore,
  state: FlatLoadState,
  generation: number,
  scope: FlatLoadScope,
  options?: LoadSessionsOptions
): Promise<void> {
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
      includeExternalHistory: scope.includeExternalHistory,
      sortBy: filter?.sortBy ?? "updated_at",
      sortOrder: filter?.sortOrder ?? "desc",
      disabledExternalHistorySources:
        scope.disabledSources.length > 0 ? scope.disabledSources : undefined,
    });

    const fetched: Session[] = mergeGuestImportedSessions(
      toFrontendSessions((response as SessionListResponse).sessions)
    );

    fetched.sort((sessionA, sessionB) =>
      (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
    );

    if (state.generation !== generation) return;

    store.set(sessionsAtom, fetched);
    persistSessions(fetched);
    store.set(sessionFlatListLastLoadedBySignatureAtom, (prev) => ({
      ...prev,
      [scope.cacheSignature]: Date.now(),
    }));
  } catch (error) {
    if (state.generation !== generation) return;
    log.error("[SessionAtom] Failed to load sessions:", error);
    store.set(
      sessionErrorAtom,
      error instanceof Error ? error.message : "Failed to load sessions"
    );
  } finally {
    if (state.generation === generation) {
      store.set(sessionLoadingAtom, false);
    }
  }
}

/**
 * Coordinate flat-list requests across every hook instance using this store.
 *
 * Equal scopes share one request. A stronger forced refresh or changed scope
 * supersedes the current generation, waits for it to release the IPC slot,
 * and then performs one trailing request. Superseded responses never write.
 */
export const loadSessions = async (
  options?: LoadSessionsOptions
): Promise<void> => {
  const store = getStore();
  const forceRefresh = options?.forceRefresh ?? false;
  const scope = getFlatLoadScope(store, options);
  const lastLoaded = store.get(sessionFlatListLastLoadedBySignatureAtom)[
    scope.cacheSignature
  ];

  if (
    !forceRefresh &&
    lastLoaded &&
    Date.now() - lastLoaded < BULK_CACHE_DURATION_MS
  ) {
    return;
  }

  let state = flatLoadStateByStore.get(store);
  if (!state) {
    state = { generation: 0 };
    flatLoadStateByStore.set(store, state);
  }

  const current = state.flight;
  if (current) {
    const currentSatisfiesRequest =
      current.scopeKey === scope.scopeKey &&
      (!forceRefresh || current.forceRefresh);
    if (currentSatisfiesRequest) return current.promise;

    // Fence the old response immediately, before waiting for its IPC call.
    state.generation += 1;
    await current.promise;
    return loadSessions(options);
  }

  const generation = state.generation + 1;
  state.generation = generation;
  const promise = performFlatSessionLoad(
    store,
    state,
    generation,
    scope,
    options
  );
  state.flight = {
    scopeKey: scope.scopeKey,
    forceRefresh,
    generation,
    promise,
  };

  try {
    await promise;
  } finally {
    if (state.flight?.promise === promise) {
      state.flight = undefined;
    }
  }
};

interface FetchPageResult {
  sessions: Session[];
  hasMore: boolean;
  dateBuckets?: DateBucketPaginationMap;
}

async function fetchAggregatePage(
  wireCategory: "cli" | "agent",
  offset: number,
  pageSize: number
): Promise<FetchPageResult> {
  const response = await sessionAggregateList({
    category: wireCategory,
    includeExternalHistory: false,
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

async function loadCategoryPage(
  category: SessionListCategory,
  offset: number,
  pageSize: number,
  dateBuckets?: DateBucketPaginationMap
): Promise<FetchPageResult> {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    if (!source) return { sessions: [], hasMore: false };
    return loadImportedHistorySourcePage(source, dateBuckets, pageSize);
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
  incoming: readonly Session[],
  preserveImportedChildren = true
): Session[] {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    return source
      ? replaceExternalHistorySourceFirstPage(
          prev,
          incoming,
          source,
          preserveImportedChildren
        )
      : mergeSessions(prev, incoming);
  }
  return mergeSessions(prev, incoming);
}

function getSidebarLoadScopeKey(store: SessionStore, pageSize: number): string {
  const configuredSources = Object.entries(store.get(dataSourceConfigAtom))
    .map(([sourceId, config]) => [sourceId, config?.enabled !== false] as const)
    .sort(([sourceA], [sourceB]) => sourceA.localeCompare(sourceB));
  return JSON.stringify([
    pageSize,
    store.get(externalSessionsEnabledAtom),
    configuredSources,
  ]);
}

async function performSidebarSessionsLoad(
  store: SessionStore,
  options?: {
    pageSize?: number;
    forceRefresh?: boolean;
  }
): Promise<void> {
  const pageSize = options?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const now = Date.now();

  store.set(sessionLoadingAtom, true);
  store.set(sessionErrorAtom, null);
  store.set(sessionPaginationAtom, resetPaginationState());

  // Sources the user has disabled in the Data Sources panel must not load;
  // the master external-sessions switch disables all of them at once.
  const dataSourceConfig = store.get(dataSourceConfigAtom);
  const externalSessionsEnabled = store.get(externalSessionsEnabledAtom);
  const isCategoryDisabled = (category: string): boolean => {
    if (!isImportedHistoryListCategory(category)) return false;
    if (!externalSessionsEnabled) return true;
    const source = getImportedHistorySourceByListCategory(category);
    return source ? isSourceDisabled(dataSourceConfig, source.sourceId) : false;
  };

  for (const category of SESSION_LIST_CATEGORIES) {
    setPaginationFor(category, { loading: true });
  }

  const enabledCategories = SESSION_LIST_CATEGORIES.filter((category) => {
    if (!isCategoryDisabled(category)) return true;
    store.set(sessionsAtom, (prev) =>
      replaceFirstPageForCategory(category, prev, [], false)
    );
    setPaginationFor(category, {
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    return false;
  });

  const applyInitialPage = (
    category: SessionListCategory,
    { sessions, hasMore, dateBuckets }: FetchPageResult
  ) => {
    store.set(sessionsAtom, (prev) =>
      replaceFirstPageForCategory(category, prev, sessions)
    );
    setPaginationFor(category, {
      loaded: sessions.length,
      hasMore,
      loading: false,
      dateBuckets,
    });
  };

  const nativeTasks = enabledCategories
    .filter((category) => !isImportedHistoryListCategory(category))
    .map(async (category) => {
      try {
        const result = await loadCategoryPage(category, 0, pageSize);
        applyInitialPage(category, result);
      } catch (error) {
        log.warn(`[SessionAtom] ${category} initial page failed:`, error);
        setPaginationFor(category, { loading: false });
      }
    });

  const importedCategories = enabledCategories.flatMap((category) => {
    if (!isImportedHistoryListCategory(category)) return [];
    const source = getImportedHistorySourceByListCategory(category);
    return source ? [{ category, source }] : [];
  });
  const importedTask = (async () => {
    if (importedCategories.length === 0) return;
    try {
      const pages = await loadImportedHistorySourcePages(
        importedCategories.map(({ source }) => ({ source })),
        pageSize
      );
      for (const { category, source } of importedCategories) {
        const page = pages.get(source.sourceId);
        if (!page) {
          throw new Error(
            `External history sidebar page missing ${source.sourceId}`
          );
        }
        applyInitialPage(category, page);
      }
    } catch (error) {
      log.warn("[SessionAtom] external history initial pages failed:", error);
      for (const { category } of importedCategories) {
        setPaginationFor(category, { loading: false });
      }
    }
  })();

  await Promise.allSettled([...nativeTasks, importedTask]);

  const merged = store.get(sessionsAtom);
  persistSessions(merged);
  store.set(sessionLastLoadedAtom, now);
  store.set(sessionLoadingAtom, false);
}

/**
 * Share one sidebar refresh between concurrent consumers.
 *
 * Mount, search, auto-scan, and manual refresh can all request the same initial
 * pages in one interaction. The first request starts immediately; later
 * callers await it instead of duplicating the two aggregate queries and the
 * external-history batch.
 */
export const loadSidebarSessions = async (options?: {
  pageSize?: number;
  forceRefresh?: boolean;
}): Promise<void> => {
  const store = getStore();
  const pageSize = options?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const lastLoaded = store.get(sessionLastLoadedAtom);
  if (
    !options?.forceRefresh &&
    lastLoaded &&
    Date.now() - lastLoaded < BULK_CACHE_DURATION_MS
  ) {
    return;
  }

  const inFlight = sidebarLoadInFlightByStore.get(store);
  const scopeKey = getSidebarLoadScopeKey(store, pageSize);
  if (inFlight) {
    if (inFlight.scopeKey === scopeKey) return inFlight.promise;
    try {
      await inFlight.promise;
    } catch {
      // The caller targets a newer scope and still deserves its own attempt.
    }
    return loadSidebarSessions(options);
  }

  const pass = performSidebarSessionsLoad(store, options);
  sidebarLoadInFlightByStore.set(store, { scopeKey, promise: pass });
  try {
    await pass;
  } finally {
    if (sidebarLoadInFlightByStore.get(store)?.promise === pass) {
      sidebarLoadInFlightByStore.delete(store);
    }
  }
};

/**
 * Hydrate one canonical session row for sidebar deep-link navigation.
 *
 * Normal sidebar loading is intentionally paginated per source/date bucket.
 * A file-history link may target a much older session, so walking those pages
 * would be both slow and nondeterministic. The aggregate API resolves the exact
 * canonical ID and this function merges only that authoritative row.
 */
export const loadSidebarSessionById = async (
  sessionId: string
): Promise<Session | null> => {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;

  const store = getStore();
  // Do not return an existing atom row before resolving the canonical record.
  // Transcript activation can insert a lightweight row first; imported
  // subagent rows in particular need the provider cache's parentSessionId so
  // the sidebar can place them beneath the root session deterministically.
  const response = await sessionAggregateList({
    sessionIds: [normalizedSessionId],
    includeExternalHistory: store.get(externalSessionsEnabledAtom),
    limit: 1,
  });
  const session = toFrontendSessions(response.sessions).find(
    (candidate) => candidate.session_id === normalizedSessionId
  );
  if (!session) return null;

  store.set(sessionsAtom, (previous) => mergeSessions(previous, [session]));
  persistSessions(store.get(sessionsAtom));
  return session;
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
    const { sessions, hasMore, dateBuckets } = await loadCategoryPage(
      category,
      current.loaded,
      pageSize,
      current.dateBuckets
    );
    const primarySessions = sessions.filter(isPrimarySessionListSession);
    store.set(sessionsAtom, (prev) => mergeSessions(prev, primarySessions));
    setPaginationFor(category, {
      loaded: current.loaded + sessions.length,
      hasMore,
      loading: false,
      dateBuckets,
    });
    persistSessions(store.get(sessionsAtom));
  } catch (error) {
    log.warn(`[SessionAtom] loadMoreCategory(${category}) failed:`, error);
    setPaginationFor(category, { loading: false });
  }
};

export const __TESTS_ONLY = {
  mergeSessions,
  replaceExternalHistorySourceFirstPage,
};
