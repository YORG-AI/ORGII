import { invoke } from "@tauri-apps/api/core";

import {
  repoPathAtom,
  repositoryIdAtom,
  repositoryNameAtom,
} from "@src/engines/SessionCore/workspace/atoms/sessionAtoms";
import { reposAtom, selectedRepoIdAtom } from "@src/store/repo/atoms";
import { REPO_KIND, type Repo } from "@src/store/repo/types";
import { sessionCreatorStateAtom } from "@src/store/session/creatorStateAtom";
import {
  activeFolderIdAtom,
  activeWorkspaceIdAtom,
  activeWorkspaceNameAtom,
  workspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import {
  activeFolderAtom,
  primaryFolderAtom,
} from "@src/store/workspace/derived";

import { asError } from "../result";
import type {
  E2EStore,
  EnsureRepoSelectedOptions,
  Json,
  Result,
  SeedMultiRootWorkspaceOptions,
} from "../types";
import { e2eUrl } from "./e2eBaseUrl";

export function createWorkspaceHelpers(store: E2EStore) {
  const getOrgiiRoot = async (): Promise<Result<{ path: string }>> => {
    try {
      const memPath = (await invoke("get_memory_storage_path")) as string;
      const path = memPath.replace(/[/\\]sessions\.db$/, "");
      return { ok: true, path };
    } catch (err) {
      return asError(err);
    }
  };

  const ensureRepoSelected = async (
    opts?: EnsureRepoSelectedOptions
  ): Promise<Result<{ repoId: string; path: string }>> => {
    try {
      const pinRepoPath = async (
        repoPath: string
      ): Promise<{ repoId: string; path: string }> => {
        // Register with the backend first so the app's own repo loader
        // (`useRepoLoader.loadRepos`) keeps the fixture repo when it
        // REPLACES `reposAtom` with backend rows. Front-end-only pins
        // get clobbered by the next loadRepos pass.
        let backendId: string | null = null;
        let backendName: string | null = null;
        try {
          const imported = (await invoke("server_import_repo", {
            path: repoPath,
          })) as { id?: string; repo_id?: string; name?: string };
          backendId = imported.repo_id ?? imported.id ?? null;
          backendName = imported.name ?? null;
        } catch {
          // Backend registration is best-effort (e.g. duplicate import);
          // fall through to the frontend pin.
        }
        const repoId =
          backendId ??
          `e2e-repo-${btoa(repoPath)
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 24)}`;
        const repo: Repo = {
          id: repoId,
          name:
            opts?.repoName ??
            backendName ??
            repoPath.split(/[\\/]/).filter(Boolean).pop() ??
            "E2E Repo",
          path: repoPath,
          fs_uri: repoPath,
          kind: REPO_KIND.GIT,
        };
        const folder = {
          id: repoId,
          name: repo.name,
          path: repoPath,
          uri: `file://${repoPath}`,
          isPrimary: true,
          repoId,
          kind: REPO_KIND.GIT,
        };
        const existingRepos = store.get(reposAtom);
        store.set(reposAtom, [
          repo,
          ...existingRepos.filter((existingRepo) => existingRepo.id !== repoId),
        ]);
        store.set(selectedRepoIdAtom, repoId);
        store.set(workspaceFoldersAtom, [folder]);
        store.set(activeWorkspaceIdAtom, repoId);
        store.set(activeWorkspaceNameAtom, repo.name);
        store.set(activeFolderIdAtom, repoId);
        store.set(repositoryIdAtom, repoId);
        store.set(repositoryNameAtom, repo.name);
        store.set(repoPathAtom, repoPath);
        return { repoId, path: repoPath };
      };

      if (opts?.repoPath) {
        return { ok: true, ...(await pinRepoPath(opts.repoPath)) };
      }

      const deadline = Date.now() + 15_000;
      let repos = store.get(reposAtom);
      while (repos.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        repos = store.get(reposAtom);
      }
      const currentSelected = store.get(selectedRepoIdAtom);
      const selectedRepo =
        repos.find((repo) => repo.id === currentSelected) ?? repos[0];
      if (selectedRepo?.id && selectedRepo.path) {
        if (selectedRepo.id !== currentSelected) {
          store.set(selectedRepoIdAtom, selectedRepo.id);
        }
        return { ok: true, repoId: selectedRepo.id, path: selectedRepo.path };
      }

      return {
        ok: false,
        error: "ensureRepoSelected: no repo path available",
      };
    } catch (err) {
      return asError(err);
    }
  };

  const getSelectedRepoPath = async (): Promise<Result<{ path: string }>> => {
    const selected = await ensureRepoSelected();
    if (!selected.ok) return selected;
    return { ok: true, path: selected.path };
  };

  const seedMultiRootWorkspace = async (
    opts: SeedMultiRootWorkspaceOptions
  ): Promise<
    Result<{
      workspaceId: string;
      primaryPath: string;
      additionalDirectories: string[];
    }>
  > => {
    try {
      if (!Array.isArray(opts.folders) || opts.folders.length < 2) {
        return {
          ok: false,
          error: "seedMultiRootWorkspace: at least two folders are required",
        };
      }
      const normalizedFolders = opts.folders.map((folder, index) => {
        const path = folder.path.replace(/\/+$/, "");
        return {
          id: folder.id ?? `e2e-workspace-folder-${index}`,
          name: folder.name,
          path,
          uri: `file://${path}`,
          isPrimary: folder.isPrimary ?? index === 0,
          repoId: folder.id ?? `e2e-workspace-folder-${index}`,
          kind: REPO_KIND.GIT,
        };
      });
      const primary =
        normalizedFolders.find((folder) => folder.isPrimary) ??
        normalizedFolders[0];
      const repos: Repo[] = normalizedFolders.map((folder) => ({
        id: folder.repoId,
        name: folder.name,
        path: folder.path,
        fs_uri: folder.path,
        kind: REPO_KIND.GIT,
      }));
      const workspaceId = opts.workspaceId ?? "e2e-multi-root-workspace";
      const applySeed = () => {
        store.set(workspaceFoldersAtom, normalizedFolders);
        store.set(activeWorkspaceIdAtom, workspaceId);
        store.set(activeWorkspaceNameAtom, opts.workspaceName ?? null);
        store.set(activeFolderIdAtom, primary.id);
        store.set(reposAtom, repos);
        store.set(selectedRepoIdAtom, primary.repoId);
        store.set(repositoryIdAtom, primary.repoId);
        store.set(repositoryNameAtom, primary.name);
        store.set(repoPathAtom, primary.path);
      };
      const seededPaths = new Set(
        normalizedFolders.map((folder) => folder.path)
      );
      const isSeedApplied = () => {
        const currentPaths = store
          .get(workspaceFoldersAtom)
          .map((folder) => folder.path);
        return (
          currentPaths.length === normalizedFolders.length &&
          currentPaths.every((path) => seededPaths.has(path)) &&
          store.get(repoPathAtom) === primary.path &&
          store.get(selectedRepoIdAtom) === primary.repoId
        );
      };
      applySeed();
      const deadline = Date.now() + 1_500;
      let stableChecks = 0;
      while (Date.now() < deadline && stableChecks < 3) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
        if (isSeedApplied()) {
          stableChecks += 1;
        } else {
          applySeed();
          stableChecks = 0;
        }
      }
      if (!isSeedApplied()) {
        return {
          ok: false,
          error: `seedMultiRootWorkspace: seeded workspace did not stabilize; folders=${JSON.stringify(store.get(workspaceFoldersAtom))}`,
        };
      }
      return {
        ok: true,
        workspaceId,
        primaryPath: primary.path,
        additionalDirectories: normalizedFolders
          .filter((folder) => folder.path !== primary.path)
          .map((folder) => folder.path),
      };
    } catch (err) {
      return asError(err);
    }
  };

  const clearWorkspaceRepos = async (): Promise<Result<{ cleared: true }>> => {
    try {
      store.set(reposAtom, []);
      store.set(selectedRepoIdAtom, "");
      store.set(workspaceFoldersAtom, []);
      store.set(activeWorkspaceIdAtom, null);
      store.set(activeWorkspaceNameAtom, null);
      store.set(activeFolderIdAtom, null);
      store.set(repositoryIdAtom, "");
      store.set(repositoryNameAtom, "");
      store.set(repoPathAtom, "");
      store.set(sessionCreatorStateAtom, {
        ...store.get(sessionCreatorStateAtom),
        source: null,
      });
      return { ok: true, cleared: true };
    } catch (err) {
      return asError(err);
    }
  };

  const setActiveWorkspaceFolderForTest = async (
    folderIdOrPath: string | null
  ): Promise<
    Result<{
      primaryFolder: Json | null;
      activeFolder: Json | null;
      folders: Json[];
      selectedRepoId: string;
      repoPath: string;
    }>
  > => {
    try {
      const folders = store.get(workspaceFoldersAtom);
      const matchedFolder =
        folderIdOrPath === null
          ? null
          : folders.find(
              (folder) =>
                folder.id === folderIdOrPath || folder.path === folderIdOrPath
            );
      if (folderIdOrPath !== null && !matchedFolder) {
        return {
          ok: false,
          error: `setActiveWorkspaceFolderForTest: unknown folder id/path ${folderIdOrPath}; folders=${JSON.stringify(folders)}`,
        };
      }
      store.set(activeFolderIdAtom, matchedFolder?.id ?? null);
      return {
        ok: true,
        primaryFolder: store.get(primaryFolderAtom) as Json | null,
        activeFolder: store.get(activeFolderAtom) as Json | null,
        folders: store.get(workspaceFoldersAtom) as unknown as Json[],
        selectedRepoId: store.get(selectedRepoIdAtom),
        repoPath: store.get(repoPathAtom),
      };
    } catch (err) {
      return asError(err);
    }
  };

  const readSessionWorkspaceFromDb = async (
    sessionId: string
  ): Promise<Result<{ result: Json }>> => {
    try {
      const response = await fetch(
        e2eUrl("/agent/test/session/workspace/list-from-db"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        }
      );
      const result = (await response.json()) as Json;
      return { ok: true, result };
    } catch (err) {
      return asError(err);
    }
  };

  // ============================================================
  // Git non-repo folder-workspace e2e support
  // ============================================================

  /**
   * Fetch git status for an arbitrary path by hitting the IDE server's git
   * route directly (respecting the e2e base URL / port). Used to assert the
   * benign `exists: false` response for non-git folders — distinct from a
   * transport error — which is the fix for recurring git error popups.
   */
  const getGitStatusForPath = async (
    repoPath: string
  ): Promise<Result<{ exists: boolean; httpStatus: number; raw: Json }>> => {
    try {
      const repoId = `e2e-status-${btoa(repoPath)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 24)}`;
      const query = new URLSearchParams({
        include_untracked: "true",
        path: repoPath,
      });
      const response = await fetch(
        e2eUrl(
          `/git/api/git/repo/${encodeURIComponent(repoId)}/status?${query.toString()}`
        ),
        { method: "GET" }
      );
      const httpStatus = response.status;
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const data = (body as { data?: { exists?: boolean } })?.data ?? null;
      return {
        ok: true,
        exists: data?.exists ?? false,
        httpStatus,
        raw: (body ?? null) as unknown as Json,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Pin a NON-git folder as the active workspace (kind=folder). Mirrors
   * `ensureRepoSelected` but registers a folder workspace so git-status code
   * paths exercise the folder branch.
   */
  const pinFolderWorkspace = async (
    folderPath: string,
    folderName?: string
  ): Promise<Result<{ folderId: string; path: string }>> => {
    try {
      const path = folderPath.replace(/\/+$/, "");
      const folderId = `e2e-folder-${btoa(path)
        .replace(/[^a-zA-Z0-9]/g, "")
        .slice(0, 24)}`;
      const name =
        folderName ?? path.split(/[\\/]/).filter(Boolean).pop() ?? "E2E Folder";
      const folder = {
        id: folderId,
        name,
        path,
        uri: `file://${path}`,
        isPrimary: true,
        repoId: folderId,
        kind: REPO_KIND.FOLDER,
      };
      store.set(workspaceFoldersAtom, [folder]);
      store.set(activeWorkspaceIdAtom, folderId);
      store.set(activeWorkspaceNameAtom, name);
      store.set(activeFolderIdAtom, folderId);
      store.set(repositoryIdAtom, folderId);
      store.set(repositoryNameAtom, name);
      store.set(repoPathAtom, path);
      return { ok: true, folderId, path };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    getOrgiiRoot,
    getSelectedRepoPath,
    ensureRepoSelected,
    seedMultiRootWorkspace,
    clearWorkspaceRepos,
    setActiveWorkspaceFolderForTest,
    readSessionWorkspaceFromDb,
    getGitStatusForPath,
    pinFolderWorkspace,
  };
}
