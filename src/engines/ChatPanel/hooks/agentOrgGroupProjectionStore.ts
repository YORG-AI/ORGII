import { useCallback, useSyncExternalStore } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import {
  type AgentOrgGroupProjectionItem,
  getAgentOrgGroupProjectionPage,
  subscribeAgentOrgStateChanges,
} from "@src/api/tauri/agent";

export const GROUP_PROJECTION_PUSH_DEBOUNCE_MS = 50;
export const GROUP_PROJECTION_CACHE_TTL_MS = 30_000;
export const GROUP_PROJECTION_MAX_ITEMS = 1_000;
export const GROUP_PROJECTION_MAX_PAGES = 20;
export const GROUP_PROJECTION_MAX_INACTIVE_RUNS = 16;

export interface AgentOrgGroupProjectionSnapshot {
  runId: string | null;
  items: AgentOrgGroupProjectionItem[];
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

type Subscriber = () => void;

interface CursorFrontier {
  cursor: string | null;
  hasMore: boolean;
}

interface ProjectionEntry {
  runId: string;
  sessionId: string;
  snapshot: AgentOrgGroupProjectionSnapshot;
  cursor: string | null;
  initialized: boolean;
  subscribers: Set<Subscriber>;
  generation: number;
  headRequest: Promise<void> | null;
  olderRequest: Promise<void> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  evictionTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
  frontiers: CursorFrontier[];
  loadedPageCount: number;
  lastTouchedAt: number;
}

const EMPTY_SNAPSHOT: AgentOrgGroupProjectionSnapshot = Object.freeze({
  runId: null,
  items: Object.freeze([]) as unknown as AgentOrgGroupProjectionItem[],
  hasMore: false,
  loading: false,
  loadingOlder: false,
  error: null,
});

const entries = new Map<string, ProjectionEntry>();
let unsubscribeStateChanges: (() => void) | null = null;
let unsubscribeBackendChanges: (() => void) | null = null;
let unsubscribeConnected: (() => void) | null = null;
let visibilityInstalled = false;
let focusInstalled = false;

function isVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

function itemOrder(item: AgentOrgGroupProjectionItem): [bigint, number] | null {
  const match = /^group:(\d+):(\d+)$/.exec(item.id);
  if (!match) return null;
  return [BigInt(match[1]), Number(match[2])];
}

function compareItems(
  left: AgentOrgGroupProjectionItem,
  right: AgentOrgGroupProjectionItem
): number {
  const leftKey = itemOrder(left);
  const rightKey = itemOrder(right);
  if (!leftKey || !rightKey) {
    if (leftKey) return -1;
    if (rightKey) return 1;
    return left.id.localeCompare(right.id);
  }
  if (leftKey[0] < rightKey[0]) return -1;
  if (leftKey[0] > rightKey[0]) return 1;
  return leftKey[1] - rightKey[1];
}

function mergeItems(
  current: ReadonlyArray<AgentOrgGroupProjectionItem>,
  incoming: ReadonlyArray<AgentOrgGroupProjectionItem>
): { items: AgentOrgGroupProjectionItem[]; capped: boolean } {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  const items = Array.from(byId.values()).sort(compareItems);
  const capped = items.length > GROUP_PROJECTION_MAX_ITEMS;
  return {
    items: capped ? items.slice(-GROUP_PROJECTION_MAX_ITEMS) : items,
    capped,
  };
}

function createEntry(runId: string, sessionId: string): ProjectionEntry {
  return {
    runId,
    sessionId,
    snapshot: {
      runId,
      items: [],
      hasMore: false,
      loading: true,
      loadingOlder: false,
      error: null,
    },
    cursor: null,
    initialized: false,
    subscribers: new Set(),
    generation: 0,
    headRequest: null,
    olderRequest: null,
    debounceTimer: null,
    evictionTimer: null,
    dirty: false,
    frontiers: [],
    loadedPageCount: 0,
    lastTouchedAt: Date.now(),
  };
}

function notify(entry: ProjectionEntry): void {
  entry.lastTouchedAt = Date.now();
  for (const subscriber of entry.subscribers) subscriber();
}

function updateSnapshot(
  entry: ProjectionEntry,
  patch: Partial<AgentOrgGroupProjectionSnapshot>
): void {
  entry.snapshot = { ...entry.snapshot, ...patch };
  notify(entry);
}

function requestStillCurrent(
  entry: ProjectionEntry,
  generation: number
): boolean {
  return entries.get(entry.runId) === entry && entry.generation === generation;
}

async function refreshHead(entry: ProjectionEntry): Promise<void> {
  if (entry.headRequest) return entry.headRequest;
  const generation = entry.generation;
  // Claim only the invalidations known before this request starts. A push that
  // arrives while the request is in flight sets `dirty` again and is folded
  // into one bounded follow-up refresh in `finally`.
  entry.dirty = false;
  updateSnapshot(entry, { loading: true, error: null });
  const request = getAgentOrgGroupProjectionPage({
    sessionId: entry.sessionId,
    limit: 50,
  })
    .then((page) => {
      if (!requestStillCurrent(entry, generation)) return;
      if (page.runId !== entry.runId)
        throw new Error("group_projection_run_mismatch");
      const existingIds = new Set(entry.snapshot.items.map((item) => item.id));
      const overlaps = page.items.some((item) => existingIds.has(item.id));
      if (
        entry.initialized &&
        entry.snapshot.items.length > 0 &&
        page.items.length > 0 &&
        !overlaps &&
        page.hasMore
      ) {
        entry.frontiers.push({
          cursor: entry.cursor,
          hasMore: entry.snapshot.hasMore,
        });
        if (entry.frontiers.length > GROUP_PROJECTION_MAX_PAGES) {
          entry.frontiers = [];
        }
        entry.cursor = page.nextCursor ?? null;
      } else if (!entry.initialized || entry.snapshot.items.length === 0) {
        entry.cursor = page.nextCursor ?? null;
      }
      const merged = mergeItems(entry.snapshot.items, page.items);
      entry.initialized = true;
      entry.loadedPageCount = Math.max(1, entry.loadedPageCount);
      updateSnapshot(entry, {
        items: merged.items,
        hasMore: merged.capped
          ? false
          : entry.cursor !== null &&
            (page.hasMore || entry.frontiers.length > 0),
        loading: false,
        error: null,
      });
    })
    .catch((caught: unknown) => {
      if (!requestStillCurrent(entry, generation)) return;
      updateSnapshot(entry, {
        loading: false,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    })
    .finally(() => {
      if (!requestStillCurrent(entry, generation)) return;
      entry.headRequest = null;
      if (entry.dirty && entry.subscribers.size > 0 && isVisible()) {
        scheduleRefresh(entry);
      }
    });
  entry.headRequest = request;
  return request;
}

async function loadOlderEntry(entry: ProjectionEntry): Promise<void> {
  if (entry.olderRequest) return entry.olderRequest;
  if (
    !entry.snapshot.hasMore ||
    !entry.cursor ||
    entry.loadedPageCount >= GROUP_PROJECTION_MAX_PAGES
  ) {
    if (entry.snapshot.hasMore) updateSnapshot(entry, { hasMore: false });
    return;
  }
  const generation = entry.generation;
  const cursor = entry.cursor;
  updateSnapshot(entry, { loadingOlder: true, error: null });
  const request = getAgentOrgGroupProjectionPage({
    sessionId: entry.sessionId,
    cursor,
    limit: 50,
  })
    .then((page) => {
      if (!requestStillCurrent(entry, generation) || entry.cursor !== cursor)
        return;
      if (page.runId !== entry.runId)
        throw new Error("group_projection_run_mismatch");
      const existingIds = new Set(entry.snapshot.items.map((item) => item.id));
      const overlaps = page.items.some((item) => existingIds.has(item.id));
      const merged = mergeItems(entry.snapshot.items, page.items);
      entry.loadedPageCount += 1;
      if (overlaps && entry.frontiers.length > 0) {
        const frontier = entry.frontiers.pop();
        entry.cursor = frontier?.cursor ?? null;
      } else {
        entry.cursor = page.nextCursor ?? null;
      }
      const pageBudgetReached =
        entry.loadedPageCount >= GROUP_PROJECTION_MAX_PAGES;
      updateSnapshot(entry, {
        items: merged.items,
        hasMore:
          !merged.capped &&
          !pageBudgetReached &&
          entry.cursor !== null &&
          (page.hasMore || entry.frontiers.length > 0),
        loadingOlder: false,
        error: null,
      });
    })
    .catch((caught: unknown) => {
      if (!requestStillCurrent(entry, generation)) return;
      updateSnapshot(entry, {
        loadingOlder: false,
        error: caught instanceof Error ? caught.message : String(caught),
      });
    })
    .finally(() => {
      if (requestStillCurrent(entry, generation)) entry.olderRequest = null;
    });
  entry.olderRequest = request;
  return request;
}

function scheduleRefresh(entry: ProjectionEntry): void {
  entry.dirty = true;
  if (!isVisible()) return;
  if (entry.debounceTimer) return;
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null;
    if (isVisible() && entry.subscribers.size > 0 && entry.dirty)
      void refreshHead(entry);
  }, GROUP_PROJECTION_PUSH_DEBOUNCE_MS);
}

async function requestRefresh(entry: ProjectionEntry): Promise<void> {
  entry.dirty = true;
  if (!isVisible()) return;
  await refreshHead(entry);
  // An explicit read-back must not resolve against a request that started
  // before the mutation it is verifying. `refreshHead` marks a concurrent
  // invalidation dirty; consume exactly one such follow-up immediately so a
  // lost RPC response can be reconciled by exact Turn id before the caller
  // decides whether retrying might duplicate work.
  if (
    requestStillCurrent(entry, entry.generation) &&
    entry.dirty &&
    entry.subscribers.size > 0 &&
    isVisible()
  ) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    await refreshHead(entry);
  }
}

function reconcileVisibleEntries(): void {
  if (!isVisible()) return;
  for (const entry of entries.values()) {
    if (entry.subscribers.size > 0) scheduleRefresh(entry);
  }
}

function handleVisibilityChange(): void {
  if (isVisible()) {
    reconcileVisibleEntries();
    return;
  }
  for (const entry of entries.values()) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
  }
}

function startGlobalListeners(): void {
  if (!unsubscribeStateChanges) {
    unsubscribeStateChanges = subscribeAgentOrgStateChanges((sessionId) => {
      for (const entry of entries.values()) {
        if (entry.sessionId === sessionId && entry.subscribers.size > 0) {
          scheduleRefresh(entry);
        }
      }
    });
  }
  if (!unsubscribeBackendChanges) {
    unsubscribeBackendChanges =
      getCodeEditorWebSocket()?.on("agent_org:run_changed", (event) => {
        const runId = (event.payload as { orgRunId?: unknown } | undefined)
          ?.orgRunId;
        if (typeof runId !== "string") return;
        const entry = entries.get(runId);
        if (entry?.subscribers.size) scheduleRefresh(entry);
      }) ?? null;
  }
  if (!unsubscribeConnected) {
    unsubscribeConnected =
      getCodeEditorWebSocket()?.on("connected", () => {
        for (const entry of entries.values()) {
          if (entry.subscribers.size > 0) scheduleRefresh(entry);
        }
      }) ?? null;
  }
  if (typeof document !== "undefined" && !visibilityInstalled) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityInstalled = true;
  }
  if (typeof window !== "undefined" && !focusInstalled) {
    window.addEventListener("focus", reconcileVisibleEntries);
    focusInstalled = true;
  }
}

function stopGlobalListenersIfIdle(): void {
  const hasSubscribers = Array.from(entries.values()).some(
    (entry) => entry.subscribers.size > 0
  );
  if (hasSubscribers) return;
  unsubscribeStateChanges?.();
  unsubscribeStateChanges = null;
  unsubscribeBackendChanges?.();
  unsubscribeBackendChanges = null;
  unsubscribeConnected?.();
  unsubscribeConnected = null;
  if (typeof document !== "undefined" && visibilityInstalled) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilityInstalled = false;
  }
  if (typeof window !== "undefined" && focusInstalled) {
    window.removeEventListener("focus", reconcileVisibleEntries);
    focusInstalled = false;
  }
}

function destroyEntry(entry: ProjectionEntry): void {
  entry.generation += 1;
  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
  entry.debounceTimer = null;
  entry.evictionTimer = null;
  entry.headRequest = null;
  entry.olderRequest = null;
  entry.subscribers.clear();
  entries.delete(entry.runId);
}

function evictInactiveOverflow(): void {
  const inactive = Array.from(entries.values())
    .filter((entry) => entry.subscribers.size === 0)
    .sort((left, right) => left.lastTouchedAt - right.lastTouchedAt);
  while (inactive.length > GROUP_PROJECTION_MAX_INACTIVE_RUNS) {
    const entry = inactive.shift();
    if (entry) destroyEntry(entry);
  }
}

export function subscribeAgentOrgGroupProjection(
  runId: string,
  sessionId: string,
  subscriber: Subscriber
): () => void {
  let entry = entries.get(runId);
  if (!entry) {
    entry = createEntry(runId, sessionId);
    entries.set(runId, entry);
  } else {
    entry.sessionId = sessionId;
  }
  if (entry.evictionTimer) clearTimeout(entry.evictionTimer);
  entry.evictionTimer = null;
  entry.subscribers.add(subscriber);
  startGlobalListeners();
  if (!entry.initialized || entry.dirty) void requestRefresh(entry);
  return () => {
    const current = entries.get(runId);
    if (!current) return;
    current.subscribers.delete(subscriber);
    if (current.subscribers.size === 0) {
      current.generation += 1;
      // Reopening within the TTL must still revalidate. Any in-flight request
      // was deliberately detached by the generation fence below, so treating
      // the retained snapshot as clean could strand an empty/stale cache.
      current.dirty = true;
      if (current.debounceTimer) clearTimeout(current.debounceTimer);
      current.debounceTimer = null;
      current.headRequest = null;
      current.olderRequest = null;
      current.snapshot = {
        ...current.snapshot,
        loading: false,
        loadingOlder: false,
      };
      current.evictionTimer = setTimeout(() => {
        if (current.subscribers.size === 0) destroyEntry(current);
        stopGlobalListenersIfIdle();
      }, GROUP_PROJECTION_CACHE_TTL_MS);
      evictInactiveOverflow();
    }
    stopGlobalListenersIfIdle();
  };
}

export function getAgentOrgGroupProjectionSnapshot(
  runId: string | null
): AgentOrgGroupProjectionSnapshot {
  return (runId ? entries.get(runId)?.snapshot : null) ?? EMPTY_SNAPSHOT;
}

export function refreshAgentOrgGroupProjection(runId: string): Promise<void> {
  const entry = entries.get(runId);
  if (!entry) return Promise.resolve();
  return requestRefresh(entry);
}

export function loadOlderAgentOrgGroupProjection(runId: string): Promise<void> {
  const entry = entries.get(runId);
  return entry ? loadOlderEntry(entry) : Promise.resolve();
}

export function disposeAgentOrgGroupProjection(runId: string): void {
  const entry = entries.get(runId);
  if (entry) destroyEntry(entry);
  stopGlobalListenersIfIdle();
}

export function useAgentOrgGroupProjection(
  runId: string | null,
  sessionId: string,
  enabled: boolean
): AgentOrgGroupProjectionSnapshot & {
  refresh: () => Promise<void>;
  loadOlder: () => Promise<void>;
} {
  const activeRunId = enabled ? runId : null;
  const subscribe = useCallback(
    (subscriber: Subscriber) =>
      activeRunId
        ? subscribeAgentOrgGroupProjection(activeRunId, sessionId, subscriber)
        : () => undefined,
    [activeRunId, sessionId]
  );
  const getSnapshot = useCallback(
    () => getAgentOrgGroupProjectionSnapshot(activeRunId),
    [activeRunId]
  );
  const refresh = useCallback(
    () =>
      activeRunId
        ? refreshAgentOrgGroupProjection(activeRunId)
        : Promise.resolve(),
    [activeRunId]
  );
  const loadOlder = useCallback(
    () =>
      activeRunId
        ? loadOlderAgentOrgGroupProjection(activeRunId)
        : Promise.resolve(),
    [activeRunId]
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    refresh,
    loadOlder,
  };
}

export const agentOrgGroupProjectionStoreTestApi = {
  entries,
  mergeItems,
  disposeAgentOrgGroupProjection,
  reconcileVisibleEntries,
};
