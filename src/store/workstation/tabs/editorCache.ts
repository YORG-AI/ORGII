/**
 * WorkStation editor repo cache.
 *
 * File-tab caches and the active editor repo are partitioned by the presented
 * WorkStation workspace. A session and the Global Workspace may therefore use
 * the same repository without restoring or overwriting each other's file tabs.
 * Shared resource tabs (Browser, Terminal, Database, etc.) are not stored here.
 *
 * Persistence uses new v3 keys. On the first v3 read, a valid legacy v2 cache
 * is seeded into the Global Workspace only; session workspaces intentionally
 * start empty. This is safe because legacy data had no session ownership.
 */
import { type Getter, atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import { presentedWorkstationWorkspaceKeyAtom } from "./atoms";
import { workstationWorkspaceId } from "./storage";
import type { EditorCacheMap, EditorRepoCache, WorkStationTab } from "./types";
import type { WorkstationWorkspaceId } from "./types";

/** Maximum repos cached independently in each WorkStation workspace. */
export const MAX_EDITOR_CACHE_REPOS = 5;

/** Maximum file tabs cached for one workspace/repository pair. */
export const MAX_FILE_TABS_PER_REPO = 20;

const STORAGE_KEY_CACHE = "orgii-v3-editor-cache-by-workspace";
const STORAGE_KEY_ACTIVE_REPO = "orgii-v3-active-repo-by-workspace";
const LEGACY_STORAGE_KEY_CACHE = "orgii-v2-editor-cache";
const LEGACY_STORAGE_KEY_ACTIVE_REPO = "orgii-v2-active-repo";

export type EditorCacheByWorkspace = Partial<
  Record<WorkstationWorkspaceId, EditorCacheMap>
>;
export type ActiveEditorRepoByWorkspace = Partial<
  Record<WorkstationWorkspaceId, string | null>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkStationTab(value: unknown): value is WorkStationTab {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    isRecord(value.data)
  );
}

function sanitizeRepoCache(
  value: unknown,
  fallbackRepoPath: string
): EditorRepoCache | null {
  if (!isRecord(value)) return null;
  const repoPath =
    typeof value.repoPath === "string" ? value.repoPath : fallbackRepoPath;
  if (!repoPath) return null;
  const fileTabs = Array.isArray(value.fileTabs)
    ? value.fileTabs.filter(isWorkStationTab).slice(-MAX_FILE_TABS_PER_REPO)
    : [];
  const requestedActiveId =
    typeof value.activeFileTabId === "string" ? value.activeFileTabId : null;
  const activeFileTabId = fileTabs.some((tab) => tab.id === requestedActiveId)
    ? requestedActiveId
    : (fileTabs[0]?.id ?? null);
  return {
    repoPath,
    fileTabs,
    activeFileTabId,
    lastAccessedAt:
      typeof value.lastAccessedAt === "number" &&
      Number.isFinite(value.lastAccessedAt)
        ? value.lastAccessedAt
        : 0,
  };
}

export function sanitizeEditorCacheMap(value: unknown): EditorCacheMap {
  if (!isRecord(value)) return {};
  const entries: Array<[string, EditorRepoCache]> = [];
  for (const [repoPath, candidate] of Object.entries(value)) {
    const cache = sanitizeRepoCache(candidate, repoPath);
    if (cache) entries.push([repoPath, cache]);
  }
  entries.sort(
    ([, left], [, right]) => right.lastAccessedAt - left.lastAccessedAt
  );
  return Object.fromEntries(entries.slice(0, MAX_EDITOR_CACHE_REPOS));
}

function sanitizeCacheByWorkspace(value: unknown): EditorCacheByWorkspace {
  if (!isRecord(value)) return {};
  const result: EditorCacheByWorkspace = {};
  for (const [workspaceId, cache] of Object.entries(value)) {
    if (workspaceId !== "global" && !workspaceId.startsWith("session:")) {
      continue;
    }
    result[workspaceId as WorkstationWorkspaceId] =
      sanitizeEditorCacheMap(cache);
  }
  return result;
}

function sanitizeActiveReposByWorkspace(
  value: unknown
): ActiveEditorRepoByWorkspace {
  if (!isRecord(value)) return {};
  const result: ActiveEditorRepoByWorkspace = {};
  for (const [workspaceId, repoPath] of Object.entries(value)) {
    if (workspaceId !== "global" && !workspaceId.startsWith("session:")) {
      continue;
    }
    if (repoPath === null || typeof repoPath === "string") {
      result[workspaceId as WorkstationWorkspaceId] = repoPath;
    }
  }
  return result;
}

function readJson(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : undefined;
  } catch {
    return undefined;
  }
}

function createWorkspaceStorage<T>(options: {
  sanitize: (value: unknown) => T;
  readLegacy: () => T;
}) {
  return {
    getItem: (key: string): T => {
      const current = readJson(key);
      return current === undefined
        ? options.readLegacy()
        : options.sanitize(current);
    },
    setItem: (key: string, value: T): void => {
      localStorage.setItem(key, JSON.stringify(value));
    },
    removeItem: (key: string): void => {
      localStorage.removeItem(key);
    },
  };
}

const editorCacheByWorkspaceAtom = atomWithStorage<EditorCacheByWorkspace>(
  STORAGE_KEY_CACHE,
  {},
  createWorkspaceStorage({
    sanitize: sanitizeCacheByWorkspace,
    readLegacy: () => {
      const legacy = sanitizeEditorCacheMap(readJson(LEGACY_STORAGE_KEY_CACHE));
      return Object.keys(legacy).length > 0 ? { global: legacy } : {};
    },
  }),
  { getOnInit: true }
);
editorCacheByWorkspaceAtom.debugLabel = "editorCacheByWorkspaceAtom";

const activeEditorRepoByWorkspaceAtom =
  atomWithStorage<ActiveEditorRepoByWorkspace>(
    STORAGE_KEY_ACTIVE_REPO,
    {},
    createWorkspaceStorage({
      sanitize: sanitizeActiveReposByWorkspace,
      readLegacy: () => {
        const legacy = readJson(LEGACY_STORAGE_KEY_ACTIVE_REPO);
        return legacy === null || typeof legacy === "string"
          ? { global: legacy }
          : {};
      },
    }),
    { getOnInit: true }
  );
activeEditorRepoByWorkspaceAtom.debugLabel = "activeEditorRepoByWorkspaceAtom";

function currentWorkspaceId(get: Getter): WorkstationWorkspaceId {
  return workstationWorkspaceId(get(presentedWorkstationWorkspaceKeyAtom));
}

/** Repo cache map for the currently presented WorkStation workspace. */
export const editorCacheAtom = atom(
  (get) => get(editorCacheByWorkspaceAtom)[currentWorkspaceId(get)] ?? {},
  (
    get,
    set,
    update: EditorCacheMap | ((previous: EditorCacheMap) => EditorCacheMap)
  ) => {
    const workspaceId = currentWorkspaceId(get);
    const allCaches = get(editorCacheByWorkspaceAtom);
    const previous = allCaches[workspaceId] ?? {};
    const next = typeof update === "function" ? update(previous) : update;
    set(editorCacheByWorkspaceAtom, {
      ...allCaches,
      [workspaceId]: sanitizeEditorCacheMap(next),
    });
  }
);
editorCacheAtom.debugLabel = "editorCacheAtom";

/** Active editor repo for the currently presented WorkStation workspace. */
export const activeEditorRepoAtom = atom(
  (get) =>
    get(activeEditorRepoByWorkspaceAtom)[currentWorkspaceId(get)] ?? null,
  (get, set, repoPath: string | null) => {
    const workspaceId = currentWorkspaceId(get);
    set(activeEditorRepoByWorkspaceAtom, {
      ...get(activeEditorRepoByWorkspaceAtom),
      [workspaceId]: repoPath,
    });
  }
);
activeEditorRepoAtom.debugLabel = "activeEditorRepoAtom";

export const getRepoCacheAtom = atom((get) => {
  const cache = get(editorCacheAtom);
  return (repoPath: string): EditorRepoCache | undefined => cache[repoPath];
});
getRepoCacheAtom.debugLabel = "getRepoCacheAtom";

export const activeRepoCacheAtom = atom((get) => {
  const cache = get(editorCacheAtom);
  const activeRepo = get(activeEditorRepoAtom);
  return activeRepo ? cache[activeRepo] : undefined;
});
activeRepoCacheAtom.debugLabel = "activeRepoCacheAtom";

/** Number of repos cached in the currently presented workspace. */
export const editorCacheSizeAtom = atom(
  (get) => Object.keys(get(editorCacheAtom)).length
);
editorCacheSizeAtom.debugLabel = "editorCacheSizeAtom";

export const saveRepoCacheAtom = atom(
  null,
  (get, set, cacheEntry: EditorRepoCache) => {
    const cache = { ...get(editorCacheAtom) };
    cache[cacheEntry.repoPath] = {
      ...cacheEntry,
      fileTabs: cacheEntry.fileTabs.slice(-MAX_FILE_TABS_PER_REPO),
      lastAccessedAt: Date.now(),
    };

    const entries = Object.entries(cache);
    if (entries.length > MAX_EDITOR_CACHE_REPOS) {
      entries.sort(
        ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
      );
      for (const [repoPath] of entries.slice(
        0,
        entries.length - MAX_EDITOR_CACHE_REPOS
      )) {
        delete cache[repoPath];
      }
    }
    set(editorCacheAtom, cache);
  }
);
saveRepoCacheAtom.debugLabel = "saveRepoCacheAtom";

export const clearRepoCacheAtom = atom(null, (get, set, repoPath: string) => {
  const cache = { ...get(editorCacheAtom) };
  delete cache[repoPath];
  set(editorCacheAtom, cache);
});
clearRepoCacheAtom.debugLabel = "clearRepoCacheAtom";

/** Clears every repo cache in the currently presented workspace only. */
export const clearAllEditorCacheAtom = atom(null, (_get, set) => {
  set(editorCacheAtom, {});
});
clearAllEditorCacheAtom.debugLabel = "clearAllEditorCacheAtom";

export const switchActiveRepoAtom = atom(
  null,
  (_get, set, repoPath: string | null) => {
    set(activeEditorRepoAtom, repoPath);
  }
);
switchActiveRepoAtom.debugLabel = "switchActiveRepoAtom";
