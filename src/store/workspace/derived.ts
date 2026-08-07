/**
 * Workspace Derived Atoms
 *
 * Derived atoms that compose the multi-root workspace model with
 * editor state and the repo store. These are the canonical targets
 * for UI surfaces (status bar, toolbar pill, panel titles) and for
 * features that need to know "which folder does the user currently
 * care about" when multi-root.
 *
 * Resolution priority for activeFolderAtom:
 *   1. Explicit user override via activeFolderIdAtom
 *   2. Folder owning the currently focused editor file
 *   3. Primary folder (isPrimary)
 *   4. First folder in the list
 */
import { atom } from "jotai";

import { reposAtom, selectedRepoIdAtom } from "@src/store/repo/atoms";
import { matchRepoByPath } from "@src/store/repo/matchRepoByPath";
import type { Repo } from "@src/store/repo/types";
import { fileSelectedPathAtom } from "@src/store/workstation/codeEditor/file";
import type { WorkspaceFolder } from "@src/types/workspace";

import {
  activeFolderIdAtom,
  activeWorkspaceIdAtom,
  activeWorkspaceNameAtom,
  savedWorkspacesAtom,
  workspaceConfigPathAtom,
  workspaceFoldersAtom,
} from "../ui/workspaceFoldersAtom";

/**
 * Primary folder — the one agents/LSP/search default to in multi-root mode.
 * Falls back to the first folder if none is marked primary.
 */
export const primaryFolderAtom = atom<WorkspaceFolder | null>((get) => {
  const folders = get(workspaceFoldersAtom);
  if (folders.length === 0) return null;
  return folders.find((folder) => folder.isPrimary) ?? folders[0];
});
primaryFolderAtom.debugLabel = "primaryFolderAtom";

function normalizeFsPath(path: string | undefined): string {
  if (!path) return "";
  const stripped = path.startsWith("file://")
    ? path.replace("file://", "")
    : path;
  return stripped.replace(/\/+$/, "");
}

function findOwningFolder(
  folders: WorkspaceFolder[],
  filePath: string | null
): WorkspaceFolder | null {
  if (!filePath || folders.length === 0) return null;
  const normalized = filePath.replace(/\/+$/, "");
  // Sort by path length descending so the most-specific root wins
  // (handles nested roots, e.g. /a/b and /a/b/c).
  const sorted = [...folders].sort((a, b) => b.path.length - a.path.length);
  for (const folder of sorted) {
    const folderPath = folder.path.replace(/\/+$/, "");
    if (normalized === folderPath || normalized.startsWith(`${folderPath}/`)) {
      return folder;
    }
  }
  return null;
}

/**
 * The folder the user currently cares about. Used by status bar,
 * toolbar pill, and per-folder feature defaults.
 */
export const activeFolderAtom = atom<WorkspaceFolder | null>((get) => {
  const folders = get(workspaceFoldersAtom);
  if (folders.length === 0) return null;

  const overrideId = get(activeFolderIdAtom);
  if (overrideId) {
    const override = folders.find((folder) => folder.id === overrideId);
    if (override) return override;
  }

  const editorPath = get(fileSelectedPathAtom);
  const owning = findOwningFolder(folders, editorPath);
  if (owning) return owning;

  return get(primaryFolderAtom);
});
activeFolderAtom.debugLabel = "activeFolderAtom";

export interface ActiveWorktreeSelection {
  repoId: string;
  path: string;
  branch: string;
  isMain: boolean;
}

/** Window-local worktree context keyed by repository ID. */
export const activeWorktreeByRepoAtom = atom<
  Record<string, ActiveWorktreeSelection>
>({});
activeWorktreeByRepoAtom.debugLabel = "activeWorktreeByRepoAtom";

export const activeWorktreeAtom = atom<ActiveWorktreeSelection | null>(
  (get) => {
    const repoId = get(selectedRepoIdAtom);
    if (!repoId) return null;
    return get(activeWorktreeByRepoAtom)[repoId] ?? null;
  }
);
activeWorktreeAtom.debugLabel = "activeWorktreeAtom";

export const setActiveWorktreeAtom = atom(
  null,
  (get, set, selection: ActiveWorktreeSelection | null) => {
    const repoId = selection?.repoId ?? get(selectedRepoIdAtom);
    if (!repoId) return;

    const previous = get(activeWorktreeByRepoAtom);
    if (selection) {
      set(activeWorktreeByRepoAtom, { ...previous, [repoId]: selection });
      return;
    }

    if (!(repoId in previous)) return;
    const next = { ...previous };
    delete next[repoId];
    set(activeWorktreeByRepoAtom, next);
  }
);
setActiveWorktreeAtom.debugLabel = "setActiveWorktreeAtom";

export interface WorkspaceRootContext {
  id: string;
  name: string;
  path: string;
  uri?: string;
  kind?: WorkspaceFolder["kind"];
  repoId?: string;
  repo?: Repo;
}

function resolveFolderRepo(
  folder: WorkspaceFolder | null,
  repos: readonly Repo[]
): Repo | undefined {
  if (!folder) return undefined;
  if (folder.repoId) {
    const linked = repos.find((repo) => repo.id === folder.repoId);
    if (linked) return linked;
  }
  return matchRepoByPath(repos, folder.path);
}

function rootContextFromFolder(
  folder: WorkspaceFolder | null,
  repos: readonly Repo[]
): WorkspaceRootContext | null {
  if (!folder) return null;
  const repo = resolveFolderRepo(folder, repos);
  return {
    id: folder.id,
    name: repo?.name ?? folder.name,
    path: folder.path,
    uri: folder.uri,
    kind: folder.kind,
    repoId: folder.repoId,
    repo,
  };
}

export const activeWorkspaceFolderRepoAtom = atom<Repo | undefined>((get) => {
  return resolveFolderRepo(get(activeFolderAtom), get(reposAtom));
});
activeWorkspaceFolderRepoAtom.debugLabel = "activeWorkspaceFolderRepoAtom";

export const activeWorkspaceRootAtom = atom<WorkspaceRootContext | null>(
  (get) => {
    const folderRoot = rootContextFromFolder(
      get(activeFolderAtom),
      get(reposAtom)
    );
    const worktree = get(activeWorktreeAtom);
    if (
      !folderRoot ||
      !worktree ||
      worktree.repoId !== get(selectedRepoIdAtom)
    ) {
      return folderRoot;
    }
    return {
      ...folderRoot,
      id: `worktree:${worktree.path}`,
      name: worktree.path.split("/").pop() || folderRoot.name,
      path: worktree.path,
      uri: `file://${worktree.path}`,
      kind: "git",
      repoId: worktree.repoId,
    };
  }
);
activeWorkspaceRootAtom.debugLabel = "activeWorkspaceRootAtom";

export const activeWorkspaceRootPathAtom = atom<string>((get) => {
  return get(activeWorkspaceRootAtom)?.path ?? "";
});
activeWorkspaceRootPathAtom.debugLabel = "activeWorkspaceRootPathAtom";

export const primaryWorkspaceRootAtom = atom<WorkspaceRootContext | null>(
  (get) => rootContextFromFolder(get(primaryFolderAtom), get(reposAtom))
);
primaryWorkspaceRootAtom.debugLabel = "primaryWorkspaceRootAtom";

export const primaryWorkspaceRootPathAtom = atom<string>((get) => {
  return get(primaryWorkspaceRootAtom)?.path ?? "";
});
primaryWorkspaceRootPathAtom.debugLabel = "primaryWorkspaceRootPathAtom";

export const workspaceFolderRepoMapAtom = atom<Map<string, Repo | undefined>>(
  (get) => {
    const repos = get(reposAtom);
    return new Map(
      get(workspaceFoldersAtom).map((folder) => [
        folder.id,
        resolveFolderRepo(folder, repos),
      ])
    );
  }
);
workspaceFolderRepoMapAtom.debugLabel = "workspaceFolderRepoMapAtom";

/**
 * Display name for the current workspace.
 * - If a .orgii-workspace file is loaded: uses its filename (without extension)
 * - If a DB workspace is active: uses its saved name (e.g. "ORGII Repos")
 * - If multi-root without a saved name: "{primaryRepoName} Workspace"
 * - If single-root: the folder's name
 */
export const workspaceNameAtom = atom<string>((get) => {
  const configPath = get(workspaceConfigPathAtom);
  if (configPath) {
    const filename = configPath.split("/").pop() ?? configPath;
    return filename.replace(/\.orgii-workspace$/, "");
  }

  const activeWorkspaceId = get(activeWorkspaceIdAtom);
  if (activeWorkspaceId) {
    const savedWorkspace = get(savedWorkspacesAtom).find(
      (workspace) => workspace.workspaceId === activeWorkspaceId
    );
    if (savedWorkspace) return savedWorkspace.name;
  }

  const dbName = get(activeWorkspaceNameAtom);
  if (dbName) return dbName;

  const folders = get(workspaceFoldersAtom);
  if (folders.length === 0) return "";
  if (folders.length === 1) return folders[0].name;

  const primary = get(primaryFolderAtom) ?? folders[0];
  const repos = get(reposAtom);
  const repoName = primary.repoId
    ? repos.find((repo) => repo.id === primary.repoId)?.name
    : repos.find(
        (repo) =>
          normalizeFsPath(repo.fs_uri ?? repo.path) ===
          normalizeFsPath(primary.path)
      )?.name;

  return `${repoName ?? primary.name} Workspace`;
});
workspaceNameAtom.debugLabel = "workspaceNameAtom";

/**
 * Number of folders currently in the workspace (for UI badges like "(3)").
 */
export const workspaceFolderCountAtom = atom<number>((get) => {
  return get(workspaceFoldersAtom).length;
});
workspaceFolderCountAtom.debugLabel = "workspaceFolderCountAtom";
