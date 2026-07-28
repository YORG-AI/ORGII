/**
 * Code Search Index Store
 *
 * Keeps the archived indexing page data shape minimal while live search runs
 * through direct regex search.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

function normalizePath(path: string): string {
  return path.startsWith("file://") ? path.replace("file://", "") : path;
}

export interface IndexedRepo {
  repoId: string;
  repoPath: string;
  indexedAt: number;
  fileCount: number;
  indexSize: number;
}

export interface IndexingStatus {
  indexedRepos: IndexedRepo[];
  indexingInProgress: Set<string>;
  lastChecked: number;
}

type IndexedReposMap = Map<string, IndexedRepo>;

const indexedReposStorage = {
  getItem: (_key: string, initialValue: IndexedReposMap): IndexedReposMap => {
    return initialValue;
  },
  setItem: (_key: string, _value: IndexedReposMap): void => {},
  removeItem: (_key: string): void => {},
};

export const indexedReposAtom = atomWithStorage<IndexedReposMap>(
  "orgii:codeSearchIndexedRepos",
  new Map(),
  indexedReposStorage,
  { getOnInit: true }
);
indexedReposAtom.debugLabel = "indexedReposAtom";

export const indexingInProgressAtom = atom<Set<string>>(new Set<string>());
indexingInProgressAtom.debugLabel = "indexingInProgressAtom";

export const indexLastCheckedAtom = atom<number>(0);
indexLastCheckedAtom.debugLabel = "indexLastCheckedAtom";

export const isRepoIndexedAtom = atom((get) => (repoId: string) => {
  const indexed = get(indexedReposAtom);
  isRepoIndexedAtom.debugLabel = "isRepoIndexedAtom";
  return indexed.has(repoId);
});

export const getRepoIndexInfoAtom = atom((get) => (repoId: string) => {
  const indexed = get(indexedReposAtom);
  getRepoIndexInfoAtom.debugLabel = "getRepoIndexInfoAtom";
  return indexed.get(repoId) || null;
});

export const isRepoIndexingAtom = atom((get) => (repoId: string) => {
  const inProgress = get(indexingInProgressAtom);
  isRepoIndexingAtom.debugLabel = "isRepoIndexingAtom";
  return inProgress.has(repoId);
});

export const indexedRepoIdsAtom = atom((get) => {
  const indexed = get(indexedReposAtom);
  indexedRepoIdsAtom.debugLabel = "indexedRepoIdsAtom";
  return Array.from(indexed.keys());
});

export const unindexedRepoIdsAtom = atom((get) => (knownRepoIds: string[]) => {
  const indexed = get(indexedReposAtom);
  unindexedRepoIdsAtom.debugLabel = "unindexedRepoIdsAtom";
  const indexedIds = new Set(indexed.keys());
  return knownRepoIds.filter((id) => !indexedIds.has(id));
});

export const addIndexedRepoAtom = atom(null, (get, set, repo: IndexedRepo) => {
  const indexed = get(indexedReposAtom);
  addIndexedRepoAtom.debugLabel = "addIndexedRepoAtom";
  const updated = new Map(indexed);
  updated.set(repo.repoId, { ...repo, repoPath: normalizePath(repo.repoPath) });
  set(indexedReposAtom, updated);
  set(indexLastCheckedAtom, Date.now());
});

export const removeIndexedRepoAtom = atom(null, (get, set, repoId: string) => {
  const indexed = get(indexedReposAtom);
  removeIndexedRepoAtom.debugLabel = "removeIndexedRepoAtom";
  const updated = new Map(indexed);
  updated.delete(repoId);
  set(indexedReposAtom, updated);
  set(indexLastCheckedAtom, Date.now());
});

export const startIndexingAtom = atom(null, (get, set, repoId: string) => {
  const inProgress = get(indexingInProgressAtom);
  startIndexingAtom.debugLabel = "startIndexingAtom";
  const updated = new Set(inProgress);
  updated.add(repoId);
  set(indexingInProgressAtom, updated);
});

export const finishIndexingAtom = atom(null, (get, set, repoId: string) => {
  const inProgress = get(indexingInProgressAtom);
  finishIndexingAtom.debugLabel = "finishIndexingAtom";
  const updated = new Set(inProgress);
  updated.delete(repoId);
  set(indexingInProgressAtom, updated);
});

export const indexLastUpdatedAtom = atomWithStorage<Record<string, number>>(
  "orgii:codeSearchLastUpdated",
  {},
  undefined,
  { getOnInit: true }
);
indexLastUpdatedAtom.debugLabel = "indexLastUpdatedAtom";

export const touchIndexUpdatedAtom = atom(null, (get, set, repoId: string) => {
  const current = get(indexLastUpdatedAtom);
  set(indexLastUpdatedAtom, { ...current, [repoId]: Date.now() });
});

export const clearIndexStatusAtom = atom(null, (_get, set) => {
  set(indexedReposAtom, new Map());
  clearIndexStatusAtom.debugLabel = "clearIndexStatusAtom";
  set(indexingInProgressAtom, new Set());
  set(indexLastCheckedAtom, Date.now());
});

export type IndexingQueueOperationType = "noop";

export interface IndexingQueueItem {
  id: string;
  repoId: string;
  repoPath: string;
  repoName: string;
  operation: IndexingQueueOperationType;
  queuedAt: number;
}

export const indexingQueueAtom = atom<IndexingQueueItem[]>([]);
indexingQueueAtom.debugLabel = "indexingQueueAtom";

export const enqueueIndexingAtom = atom(
  null,
  (_get, _set, _item: Omit<IndexingQueueItem, "id" | "queuedAt">) => {}
);

export const cancelQueuedItemAtom = atom(null, (get, set, itemId: string) => {
  const queue = get(indexingQueueAtom);
  set(
    indexingQueueAtom,
    queue.filter((item) => item.id !== itemId)
  );
});

export const cancelQueuedRepoAtom = atom(null, (get, set, repoId: string) => {
  const queue = get(indexingQueueAtom);
  set(
    indexingQueueAtom,
    queue.filter((item) => item.repoId !== repoId)
  );
});

export const clearIndexingQueueAtom = atom(null, (_get, set) => {
  set(indexingQueueAtom, []);
});
