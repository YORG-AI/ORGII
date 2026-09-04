/**
 * Sidebar roster read.
 *
 * Owns the per-store roster generation counter and the exact-id batch-load
 * dedup map, the per-category page fetchers, the 181-line initial-load
 * coordinator, and the single-flight wrapper `loadSessionRoster` is built from.
 */
import {
  getImportedHistorySourceByListCategory,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";
import {
  type NativeSidebarSessionCursor,
  type NativeSidebarSessionStream,
  nativeSidebarSessionPage,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
  isSourceDisabled,
} from "../dataSourceConfigAtom";
import {
  sessionErrorAtom,
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "./atoms";
import {
  loadImportedHistorySourcePage,
  loadImportedHistorySourcePages,
} from "./importedHistoryPaging";
import {
  BULK_CACHE_DURATION_MS,
  type FetchPageResult,
  getStore,
  log,
} from "./loaderShared";
import { mergeSessions, setPaginationFor } from "./mergeSessions";
import {
  BASE_SESSION_LIST_CATEGORIES,
  type DateBucketPaginationMap,
  SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  emptyDateBucketPagination,
  sessionPaginationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import { sidebarCategoryForSession } from "./sidebarRoster";
import type { Session } from "./types";

const sidebarRosterGenerationsByStore = new WeakMap<object, number>();
const exactSessionBatchLoadsByStore = new WeakMap<
  object,
  Map<string, Promise<Session[]>>
>();

export function currentSidebarRosterGeneration(store: object): number {
  return sidebarRosterGenerationsByStore.get(store) ?? 0;
}

export function nextSidebarRosterGeneration(store: object): number {
  const generation = currentSidebarRosterGeneration(store) + 1;
  sidebarRosterGenerationsByStore.set(store, generation);
  return generation;
}

export function exactSessionBatchLoadsForStore(
  store: object
): Map<string, Promise<Session[]>> {
  let loads = exactSessionBatchLoadsByStore.get(store);
  if (!loads) {
    loads = new Map();
    exactSessionBatchLoadsByStore.set(store, loads);
  }
  return loads;
}

export async function fetchNativeSidebarPage(
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

export async function loadCategoryPage(
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

export interface SidebarLoadOptions {
  pageSize?: number;
  forceRefresh?: boolean;
}

export const performSidebarSessionLoad = async (
  options?: SidebarLoadOptions
) => {
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
  // A locally-created row can arrive while this request is in flight. Keep
  // the initial IDs as a boundary so `applyInitialPage` preserves only those
  // registrations that happened after the read started; older rows still
  // yield to the response, including legitimate remote deletions.
  const nativeRosterIdsAtLoadStart = new Map(
    BASE_SESSION_LIST_CATEGORIES.map((category) => [
      category,
      new Set(store.get(sessionPaginationAtom)[category].sessionIds),
    ])
  );
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
    const initialSessionIds = primarySessions.map(
      (session) => session.session_id
    );
    const locallyRegisteredIds = isImportedHistoryListCategory(category)
      ? []
      : store
          .get(sessionPaginationAtom)
          [category].sessionIds.filter((sessionId) => {
            if (nativeRosterIdsAtLoadStart.get(category)?.has(sessionId)) {
              return false;
            }
            const session = store
              .get(sessionsAtom)
              .find((candidate) => candidate.session_id === sessionId);
            return (
              session !== undefined &&
              isPrimarySessionListSession(session) &&
              sidebarCategoryForSession(session) === category
            );
          });
    const sessionIds = [
      ...new Set([...locallyRegisteredIds, ...initialSessionIds]),
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
        log.warn(`${category} initial page failed:`, error);
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
          log.warn(`${category} initial page failed: ${failure}`);
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

export function mergeSidebarLoadOptions(
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

export function sidebarLoadCovers(
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
export function createSidebarLoadCoordinator(
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
