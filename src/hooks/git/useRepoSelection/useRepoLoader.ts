/**
 * useRepoLoader - Handles repo loading and caching
 */
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { getRepos } from "@src/api/tauri/repo";
import { createLogger } from "@src/hooks/logger";
import {
  type CachedRepo,
  REPO_STORAGE_KEYS,
  type Repo,
  cachedReposAtom,
  lastUsedRepoAtom,
  reposAtom,
  selectedRepoIdAtom,
  updateCachedRepos,
  validRepoIdsAtom,
} from "@src/store/repo";

import {
  globalLoadInProgress,
  globalReposLoaded,
  setGlobalLoadInProgress,
  setGlobalReposLoaded,
} from "./singleton";
import type { UseRepoLoaderReturn } from "./types";

const log = createLogger("useRepoLoader");

function readStoredRepoId(key: string): string | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored) as unknown;
    return typeof parsed === "string" && parsed.trim() ? parsed : null;
  } catch {
    const trimmed = stored.trim();
    return trimmed ? trimmed : null;
  }
}

function readCachedRepoIds(): string[] {
  const stored = localStorage.getItem(REPO_STORAGE_KEYS.cachedRepos);
  if (!stored) return [];

  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((repo: unknown) => (repo as Partial<CachedRepo>).id)
      .filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0
      );
  } catch {
    return [];
  }
}

function resolveStartupRepo(
  repoList: Repo[],
  currentSelection: string | null | undefined
): Repo | undefined {
  const candidates = [
    currentSelection,
    readStoredRepoId(REPO_STORAGE_KEYS.lastUsedRepo),
    ...readCachedRepoIds(),
  ].filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0
  );

  for (const candidate of candidates) {
    const repo = repoList.find((item) => item.id === candidate);
    if (repo) return repo;
  }

  return repoList[0];
}

export function useRepoLoader(): UseRepoLoaderReturn {
  const [repos, setRepos] = useAtom(reposAtom);
  const [selectedRepoId, setSelectedRepoId] = useAtom(selectedRepoIdAtom);
  const setValidRepoIds = useSetAtom(validRepoIdsAtom);
  const [_cachedRepos, setCachedRepos] = useAtom(cachedReposAtom);
  const setLastUsedRepo = useSetAtom(lastUsedRepoAtom);

  const [repoLoading, setRepoLoading] = useState(false);
  const [reposLoaded, setReposLoaded] = useState(globalReposLoaded);

  const loadedReposRef = useRef(false);
  const loadingReposRef = useRef(false);
  const needsReloadRef = useRef(false);
  const isHotReloadRef = useRef(false);
  const selectedRepoIdRef = useRef(selectedRepoId);
  const loadGenerationRef = useRef(0);
  const forceRefreshRequestedRef = useRef(false);

  // === HOT RELOAD FIX ===
  if (repos.length > 0 && !loadedReposRef.current && !isHotReloadRef.current) {
    isHotReloadRef.current = true;
    loadedReposRef.current = true;
  }

  // === SYNC reposLoaded state ===
  useEffect(() => {
    if (repos.length > 0 && !reposLoaded) {
      setReposLoaded(true);
    }
  }, [repos.length, reposLoaded]);

  useEffect(() => {
    selectedRepoIdRef.current = selectedRepoId;
  }, [selectedRepoId]);

  // Detect need for reload after hot reload
  if (
    selectedRepoId &&
    repos.length === 0 &&
    !loadingReposRef.current &&
    !needsReloadRef.current
  ) {
    needsReloadRef.current = true;
    loadedReposRef.current = false;
  }

  const loadRepos = useCallback(async () => {
    const forceRefresh = forceRefreshRequestedRef.current;
    forceRefreshRequestedRef.current = false;
    if (globalLoadInProgress && !forceRefresh) {
      return;
    }

    if (!forceRefresh && globalReposLoaded && loadedReposRef.current) {
      return;
    }

    const generation = ++loadGenerationRef.current;
    setGlobalLoadInProgress(true);
    loadingReposRef.current = true;
    setRepoLoading(true);
    let loadSucceeded = false;

    try {
      const response = await getRepos({ forceRefresh });

      // Discard stale response when forceRefreshRepos() started a newer call.
      // The newer call already owns globalLoadInProgress and loadingReposRef,
      // so we only need to stop processing this response.
      if (generation !== loadGenerationRef.current) {
        return;
      }

      if (response?.data?.repos) {
        const repoList: Repo[] = response.data.repos.map((r: unknown) => {
          const repo = r as Record<string, unknown>;
          const visibility = repo.visibility as string | undefined;
          const kind = repo.kind as string | undefined;
          return {
            id: (repo.id || repo.repo_id) as string,
            name: String(repo.repo_name || repo.name || "Unknown"),
            path: repo.path as string,
            visibility:
              visibility === "public" || visibility === "private"
                ? visibility
                : undefined,
            kind: kind === "folder" ? ("folder" as const) : ("git" as const),
            fs_uri: repo.path as string,
            repo_url: repo.repo_url as string,
            description: String(repo.description || repo.desc || ""),
            branch: repo.branch as string,
            owner_user_id: repo.owner_user_id as string,
            project_collection_uuid: repo.project_collection_uuid as string,
            workspace_uuid: repo.workspace_uuid as string,
            created_at: repo.created_at as string,
            updated_at: repo.updated_at as string,
            stats: repo.stats as Repo["stats"],
          };
        });

        setRepos(repoList);
        setValidRepoIds(new Set(repoList.map((repo) => repo.id)));
        loadedReposRef.current = true;
        loadSucceeded = true;

        const restoredRepo = resolveStartupRepo(
          repoList,
          selectedRepoIdRef.current
        );

        if (restoredRepo) {
          if (restoredRepo.id !== selectedRepoIdRef.current) {
            setSelectedRepoId(restoredRepo.id);
          }
          setLastUsedRepo(restoredRepo.id);
          setCachedRepos((prev) => updateCachedRepos(prev, restoredRepo));
        } else if (selectedRepoIdRef.current) {
          setSelectedRepoId("");
          setLastUsedRepo("");
        }
      }
    } catch (error) {
      log.error("[useRepoLoader] Failed to load repos:", error);

      // Clear the optimistic selectedRepoId that AuthRedirect set — it was
      // never validated against the repo list and would leave a dangling ID.
      if (repos.length === 0 && selectedRepoIdRef.current) {
        setSelectedRepoId("");
      }
    } finally {
      // Only the latest generation owns the global flags.
      // A stale call (superseded by forceRefreshRepos) must not reset them.
      if (generation === loadGenerationRef.current) {
        setRepoLoading(false);
        loadingReposRef.current = false;
        setGlobalLoadInProgress(false);

        if (loadSucceeded) {
          setReposLoaded(true);
          setGlobalReposLoaded(true);
        }
      }
    }
  }, [
    repos.length,
    setRepos,
    setValidRepoIds,
    setSelectedRepoId,
    setLastUsedRepo,
    setCachedRepos,
  ]);

  const forceRefreshRepos = useCallback(async () => {
    loadedReposRef.current = false;
    setGlobalReposLoaded(false);
    forceRefreshRequestedRef.current = true;
    await loadRepos();
  }, [loadRepos]);

  // Handle hot reload triggered reload
  useEffect(() => {
    if (needsReloadRef.current && !loadingReposRef.current) {
      needsReloadRef.current = false;
      loadRepos();
    }
  }, [loadRepos, selectedRepoId]);

  // Validate selectedRepoId matches recoverable startup state on hot reload.
  useEffect(() => {
    if (!isHotReloadRef.current || repos.length === 0) return;

    const restoredRepo = resolveStartupRepo(repos, selectedRepoIdRef.current);
    if (restoredRepo && restoredRepo.id !== selectedRepoIdRef.current) {
      setSelectedRepoId(restoredRepo.id);
      setLastUsedRepo(restoredRepo.id);
      setCachedRepos((prev) => updateCachedRepos(prev, restoredRepo));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.length]);

  return {
    repoLoading,
    reposLoaded,
    loadRepos,
    forceRefreshRepos,
  };
}
