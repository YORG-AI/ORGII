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
  type NativeSidebarSessionCursor,
  type NativeSidebarSessionStream,
  type SessionFilter,
  type SessionListResponse,
  externalHistorySidebarList,
  nativeSidebarSessionPage,
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
  BASE_SESSION_LIST_CATEGORIES,
  type DateBucketPaginationMap,
  SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  type SessionPaginationMap,
  emptyDateBucketPagination,
  sessionPaginationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import {
  sidebarCategoryForSession,
  syncSessionWithNativeRosters,
} from "./sidebarRoster";
import type { Session, SessionStatus } from "./types";

const log = createLogger("SessionAtom");

const getStore = () => getInstrumentedStore();
const BULK_CACHE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_FLAT_LIST_PAGE_SIZE = 200;
const RECENT_NATIVE_REFRESH_LIMIT =
  SESSION_SIDEBAR_PAGE_SIZE * BASE_SESSION_LIST_CATEGORIES.length;
const sidebarRosterGenerationsByStore = new WeakMap<object, number>();
const exactSessionBatchLoadsByStore = new WeakMap<
  object,
  Map<string, Promise<Session[]>>
>();
const recentNativeRefreshesByStore = new WeakMap<object, Promise<void>>();

function currentSidebarRosterGeneration(store: object): number {
  return sidebarRosterGenerationsByStore.get(store) ?? 0;
}

function nextSidebarRosterGeneration(store: object): number {
  const generation = currentSidebarRosterGeneration(store) + 1;
  sidebarRosterGenerationsByStore.set(store, generation);
  return generation;
}

function exactSessionBatchLoadsForStore(
  store: object
): Map<string, Promise<Session[]>> {
  let loads = exactSessionBatchLoadsByStore.get(store);
  if (!loads) {
    loads = new Map();
    exactSessionBatchLoadsByStore.set(store, loads);
  }
  return loads;
}

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
        pinned: row.pinned ?? false,
        is_active: row.isActive ?? false,
        background: false,
        repoPath: row.repoPath,
        repoRootPath: row.repoRootPath,
        repoRemoteUrls: row.repoRemoteUrls,
        branch: row.branch,
        storagePath: row.storagePath,
        continuationLineageId: row.continuationLineageId,
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
  pageSize: number,
  failures: Map<string, string> = new Map()
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
    // A source whose store failed to read is UNKNOWN, not empty. Recording it
    // as an empty page would publish an authoritative page of zero ids and
    // retire every row that source owns.
    if (sourceResponse.error) {
      failures.set(source.sourceId, sourceResponse.error);
      continue;
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
  nextCursor?: NativeSidebarSessionCursor | null;
  dateBuckets?: DateBucketPaginationMap;
}

async function fetchNativeSidebarPage(
  stream: NativeSidebarSessionStream,
  cursor: NativeSidebarSessionCursor | null,
  pageSize: number
): Promise<FetchPageResult> {
  const response = await nativeSidebarSessionPage(stream, cursor, pageSize);
  return {
    sessions: toFrontendSessions(response.sessions).filter(
      isPrimarySessionListSession
    ),
    hasMore: response.hasMore,
    nextCursor: response.nextCursor,
  };
}

async function loadCategoryPage(
  category: SessionListCategory,
  cursor: NativeSidebarSessionCursor | null,
  pageSize: number,
  dateBuckets?: DateBucketPaginationMap
): Promise<FetchPageResult> {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    if (!source) return { sessions: [], hasMore: false };
    return loadImportedHistorySourcePage(source, dateBuckets, pageSize);
  }

  switch (category) {
    case "pinned_native":
      return fetchNativeSidebarPage("pinnedNative", cursor, pageSize);
    case "cli_agent":
      return fetchNativeSidebarPage("cliAgent", cursor, pageSize);
    case "standalone_agent":
      return fetchNativeSidebarPage("standaloneAgent", cursor, pageSize);
    case "agent_org_root":
      return fetchNativeSidebarPage("agentOrgRoot", cursor, pageSize);
    case "os_agent":
      return fetchNativeSidebarPage("osAgent", cursor, pageSize);
    case "human_session":
      return fetchNativeSidebarPage("humanSession", cursor, pageSize);
  }
}

interface SidebarLoadOptions {
  pageSize?: number;
  forceRefresh?: boolean;
}

const performSidebarSessionLoad = async (options?: SidebarLoadOptions) => {
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

  const generation = nextSidebarRosterGeneration(store);
  store.set(sessionLoadingAtom, true);
  store.set(sessionErrorAtom, null);

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
    setPaginationFor(category, { phase: "loading" });
  }

  const enabledCategories = SESSION_LIST_CATEGORIES.filter((category) => {
    if (!isCategoryDisabled(category)) return true;
    setPaginationFor(category, {
      sessionIds: [],
      cursor: null,
      phase: "exhausted",
      generation,
      dateBuckets: emptyDateBucketPagination(),
    });
    return false;
  });

  const applyInitialPage = (
    category: SessionListCategory,
    { sessions, hasMore, nextCursor, dateBuckets }: FetchPageResult
  ) => {
    if (generation !== currentSidebarRosterGeneration(store)) return;
    const primarySessions = sessions.filter(isPrimarySessionListSession);
    const sessionIds = [
      ...new Set(primarySessions.map((session) => session.session_id)),
    ];
    if (hasMore && sessionIds.length === 0) {
      throw new Error(
        `${category} returned hasMore without any roster session IDs`
      );
    }
    // Entity cache and stream window are deliberately separate. The first
    // authoritative page replaces only `sessionIds`; older cached entities
    // remain available for active/deep-link overlays.
    store.set(sessionsAtom, (prev) => mergeSessions(prev, primarySessions));
    setPaginationFor(category, {
      sessionIds,
      cursor: nextCursor ?? null,
      phase: hasMore ? "ready" : "exhausted",
      generation,
      dateBuckets,
    });
  };

  const nativeTasks = enabledCategories
    .filter((category) => !isImportedHistoryListCategory(category))
    .map(async (category) => {
      try {
        const result = await loadCategoryPage(category, null, pageSize);
        applyInitialPage(category, result);
      } catch (error) {
        log.warn(`[SessionAtom] ${category} initial page failed:`, error);
        if (generation === currentSidebarRosterGeneration(store)) {
          setPaginationFor(category, {
            cursor: null,
            phase: "error",
            generation,
          });
        }
      }
    });

  const importedCategories = enabledCategories.flatMap((category) => {
    if (!isImportedHistoryListCategory(category)) return [];
    const source = getImportedHistorySourceByListCategory(category);
    return source ? [{ category, source }] : [];
  });
  // An errored stream must not publish a roster page. `setPaginationFor`
  // merges, so writing `generation` while leaving `sessionIds` at its cold-start
  // `[]` makes `createSidebarRosterMatcher` treat that empty set as
  // authoritative and hide every row the stream owns. Native categories survive
  // this because they share one `nativeIds` union; imported categories are each
  // independently authoritative, so for them the blanking is total.
  const markImportedStreamFailed = (category: SessionListCategory) => {
    if (generation !== currentSidebarRosterGeneration(store)) return;
    setPaginationFor(category, { cursor: null, phase: "error" });
  };

  const importedTask = (async () => {
    if (importedCategories.length === 0) return;
    const failures = new Map<string, string>();
    try {
      const pages = await loadImportedHistorySourcePages(
        importedCategories.map(({ source }) => ({ source })),
        pageSize,
        failures
      );
      for (const { category, source } of importedCategories) {
        const failure = failures.get(source.sourceId);
        if (failure) {
          log.warn(`[SessionAtom] ${category} initial page failed: ${failure}`);
          markImportedStreamFailed(category);
          continue;
        }
        const page = pages.get(source.sourceId);
        if (!page) {
          log.warn(
            `[SessionAtom] external history sidebar page missing ${source.sourceId}`
          );
          markImportedStreamFailed(category);
          continue;
        }
        applyInitialPage(category, page);
      }
    } catch (error) {
      log.warn("[SessionAtom] external history initial pages failed:", error);
      for (const { category } of importedCategories) {
        markImportedStreamFailed(category);
      }
    }
  })();

  await Promise.allSettled([...nativeTasks, importedTask]);

  if (generation !== currentSidebarRosterGeneration(store)) return;
  const merged = store.get(sessionsAtom);
  persistSessions(merged);
  store.set(sessionLastLoadedAtom, now);
  store.set(sessionLoadingAtom, false);
};

function mergeSidebarLoadOptions(
  current: SidebarLoadOptions | null,
  requested: SidebarLoadOptions
): SidebarLoadOptions {
  return {
    pageSize: Math.max(
      current?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE,
      requested.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE
    ),
    forceRefresh:
      (current?.forceRefresh ?? false) || (requested.forceRefresh ?? false),
  };
}

function sidebarLoadCovers(
  active: SidebarLoadOptions | null,
  requested: SidebarLoadOptions
): boolean {
  if (!active) return false;
  const activePageSize = active.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const requestedPageSize = requested.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  return (
    activePageSize >= requestedPageSize &&
    ((active.forceRefresh ?? false) || !(requested.forceRefresh ?? false))
  );
}

/**
 * Build a single-flight coordinator around the sidebar read. Kept as a small
 * injectable unit so queue coverage, escalation, and failure recovery can be
 * tested without exercising every session provider.
 */
function createSidebarLoadCoordinator(
  load: (options?: SidebarLoadOptions) => Promise<void>
): (options?: SidebarLoadOptions) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let active: SidebarLoadOptions | null = null;
  let pending: SidebarLoadOptions | null = null;

  return (options: SidebarLoadOptions = {}): Promise<void> => {
    if (inFlight && sidebarLoadCovers(active, options)) {
      return inFlight;
    }
    pending = mergeSidebarLoadOptions(pending, options);
    if (inFlight) return inFlight;

    const run = async () => {
      while (pending) {
        const next = pending;
        pending = null;
        active = next;
        await load(next);
      }
    };
    inFlight = run().finally(() => {
      active = null;
      inFlight = null;
    });
    return inFlight;
  };
}

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

function importedPageHasProgress(
  dateBuckets: DateBucketPaginationMap | undefined
): boolean {
  return dateBuckets
    ? SESSION_DATE_BUCKET_KEYS.some((bucket) => dateBuckets[bucket].loaded > 0)
    : false;
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

export const __TESTS_ONLY = {
  createSidebarLoadCoordinator,
  mergeSessions,
  replaceExternalHistorySourceFirstPage,
};
