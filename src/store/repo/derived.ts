/**
 * Repo Store Derived Atoms
 *
 * Computed/derived atoms that depend on core atoms.
 */
import { atom } from "jotai";

import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  activeFolderIdAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";

import {
  branchesAtom,
  cachedReposAtom,
  repoFilterAtom,
  repoLastCheckAtom,
  reposAtom,
  selectedRepoIdAtom,
  validRepoIdsAtom,
} from "./atoms";
import { matchRepoByPath, normalizeRepoPath } from "./matchRepoByPath";
import { REPO_KIND, type Repo } from "./types";

function repoPath(repo: Repo | undefined): string {
  return repo?.path ?? repo?.fs_uri ?? "";
}

// ============================================
// Repo Lookups
// ============================================

/** Map for O(1) repo lookups by ID */
export const repoMapAtom = atom<Map<string, Repo>>((get) => {
  const repos = get(reposAtom);
  return new Map(repos.map((repo) => [repo.id, repo]));
});
repoMapAtom.debugLabel = "repoMapAtom";

export const selectedRepoAtom = atom<Repo | undefined>((get) => {
  const selectedId = get(selectedRepoIdAtom);
  if (!selectedId) return undefined;

  const mainRepo = get(repoMapAtom).get(selectedId);
  if (mainRepo) return mainRepo;

  const cachedRepo = get(cachedReposAtom).find(
    (repo) => repo.id === selectedId
  );
  if (!cachedRepo) return undefined;

  return {
    id: cachedRepo.id,
    name: cachedRepo.name,
    path: cachedRepo.path,
    fs_uri: cachedRepo.path,
    repo_url: cachedRepo.repo_url,
    kind: REPO_KIND.GIT,
  } as Repo;
});
selectedRepoAtom.debugLabel = "selectedRepoAtom";

export const selectedRepoPathAtom = atom<string>((get) => {
  return repoPath(get(selectedRepoAtom));
});
selectedRepoPathAtom.debugLabel = "selectedRepoPathAtom";

/** Check if a repo ID is valid */
export const isValidRepoIdAtom = atom((get) => {
  const validIds = get(validRepoIdsAtom);
  return (id: string) => validIds.has(id);
});
isValidRepoIdAtom.debugLabel = "isValidRepoIdAtom";

// ============================================
// Filtered & Search
// ============================================

/** Filtered repos by search term */
export const filteredReposAtom = atom((get) => {
  const repos = get(reposAtom);
  const filter = get(repoFilterAtom);
  if (!filter) return repos;
  return repos.filter((repo) =>
    repo.name.toLowerCase().includes(filter.toLowerCase())
  );
});
filteredReposAtom.debugLabel = "filteredReposAtom";

/** Branch options for dropdowns */
export const branchOptionsAtom = atom((get) => {
  const branches = get(branchesAtom);
  return branches.map((branch) => ({
    label: branch.name,
    value: branch.name,
    subLabel: branch.lastCommitDate,
  }));
});
branchOptionsAtom.debugLabel = "branchOptionsAtom";

// ============================================
// Stats Atoms
// ============================================

/** Total number of repos */
export const repoCountAtom = atom((get) => {
  return get(reposAtom).length;
});
repoCountAtom.debugLabel = "repoCountAtom";

/** Check if there are any repos */
export const hasReposAtom = atom((get) => {
  return get(reposAtom).length > 0;
});
hasReposAtom.debugLabel = "hasReposAtom";

/** Check if selected repo is valid */
export const isSelectedRepoValidAtom = atom((get) => {
  const selectedId = get(selectedRepoIdAtom);
  const validIds = get(validRepoIdsAtom);
  return selectedId ? validIds.has(selectedId) : false;
});
isSelectedRepoValidAtom.debugLabel = "isSelectedRepoValidAtom";

/** Repos grouped by type (local vs remote) */
export const reposByTypeAtom = atom((get) => {
  const repos = get(reposAtom);
  return {
    local: repos.filter((repo) => !repo.repo_url),
    remote: repos.filter((repo) => !!repo.repo_url),
  };
});
reposByTypeAtom.debugLabel = "reposByTypeAtom";

// ============================================
// Kind-based Filtering (git repos vs work folders)
// ============================================

/** Only git repositories */
export const gitReposAtom = atom((get) => {
  return get(reposAtom).filter((repo) => repo.kind !== REPO_KIND.FOLDER);
});
gitReposAtom.debugLabel = "gitReposAtom";

/** Only work folders */
export const workFoldersAtom = atom((get) => {
  return get(reposAtom).filter((repo) => repo.kind === REPO_KIND.FOLDER);
});
workFoldersAtom.debugLabel = "workFoldersAtom";

/** Whether the currently selected repo is a git repository (not a work folder) */
export const currentRepoIsGitAtom = atom((get) => {
  const repo = get(selectedRepoAtom);
  return repo?.kind !== REPO_KIND.FOLDER;
});
currentRepoIsGitAtom.debugLabel = "currentRepoIsGitAtom";

/** Total stats across all repos */
export const repoTotalStatsAtom = atom((get) => {
  const repos = get(reposAtom);
  return repos.reduce(
    (acc, repo) => ({
      sessions: acc.sessions + (repo.stats?.sessions || 0),
      linkedProjects: acc.linkedProjects + (repo.stats?.linked_stories || 0),
      workItems: acc.workItems + (repo.stats?.work_items || 0),
      contextItems: acc.contextItems + (repo.stats?.context_items || 0),
    }),
    { sessions: 0, linkedProjects: 0, workItems: 0, contextItems: 0 }
  );
});
repoTotalStatsAtom.debugLabel = "repoTotalStatsAtom";

/** Computed: How long ago repos were loaded (in seconds) */
export const repoAgeSecondsAtom = atom<number | null>((get) => {
  const lastCheck = get(repoLastCheckAtom);
  if (!lastCheck) return null;
  return Math.floor((Date.now() - lastCheck.getTime()) / 1000);
});
repoAgeSecondsAtom.debugLabel = "repoAgeSecondsAtom";

/**
 * When the active WorkStation session's repo differs from the currently
 * selected My Station workspace/root, returns the matching target so the
 * status bar can show a "Switch to <name>" hint button.
 *
 * Returns `null` when:
 * - no active session, or the session has no repoPath
 * - the session repo already matches the current workspace
 * - the session repo is not found in the known repos or workspace folders
 */
export const sessionRepoHintAtom = atom<
  | {
      type: "repo";
      repoId: string;
      repoName: string;
    }
  | {
      type: "folder";
      folderId: string;
      folderName: string;
      repoId?: string;
    }
  | null
>((get) => {
  const activeSessionId = get(workstationActiveSessionIdAtom);
  if (!activeSessionId) return null;

  const sessions = get(sessionsAtom);
  const session = sessions.find((s) => s.session_id === activeSessionId);
  const sessionRepoPath = session?.repoPath;
  if (!sessionRepoPath) return null;

  const repos = get(reposAtom);
  const folders = get(workspaceFoldersAtom);
  if (folders.length > 1) {
    const normalizedSessionPath = normalizeRepoPath(sessionRepoPath);
    const folderMatch = folders.find(
      (folder) => normalizeRepoPath(folder.path) === normalizedSessionPath
    );

    if (folderMatch) {
      const currentFolderId =
        get(activeFolderIdAtom) ??
        folders.find((folder) => folder.isPrimary)?.id ??
        folders[0]?.id;
      if (folderMatch.id === currentFolderId) return null;

      const repoMatch =
        (folderMatch.repoId
          ? repos.find((repo) => repo.id === folderMatch.repoId)
          : undefined) ?? matchRepoByPath(repos, folderMatch.path);
      return {
        type: "folder",
        folderId: folderMatch.id,
        folderName: repoMatch?.name ?? folderMatch.name,
        repoId: repoMatch?.id ?? folderMatch.repoId,
      };
    }
  }

  const selectedId = get(selectedRepoIdAtom);
  const match = matchRepoByPath(repos, sessionRepoPath);

  if (!match) return null;
  if (match.id === selectedId) return null;

  return { type: "repo", repoId: match.id, repoName: match.name };
});
sessionRepoHintAtom.debugLabel = "sessionRepoHintAtom";
