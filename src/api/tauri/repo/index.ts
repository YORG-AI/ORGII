/**
 * Repository API Endpoints
 *
 * Uses Tauri commands for all repo operations.
 */
import { invoke as invokeTauri } from "@tauri-apps/api/core";

// ============================================
// Types
// ============================================

/** Repository kind: git repo or plain work folder */
export type RepoKind = "git" | "folder";

/** Repository info */
export interface Repo {
  repo_id: string;
  user_id: string;
  name: string;
  path: string;
  visibility?: "public" | "private";
  kind: RepoKind;
}

/** Repository list */
export interface RepoList {
  repos: Repo[];
}

// ============================================
// Tauri response wrapper
// ============================================

/** Wraps Tauri result in the shape callers expect */
function wrapResponse<T>(data: T) {
  return { data, status: 0 };
}

// ============================================
// Repository CRUD (via Tauri commands)
// ============================================

/** Get current user's repository list */
export async function getRepos() {
  const repos = await invokeTauri<
    Array<{
      id: string;
      repo_id: string;
      name: string;
      path: string;
      visibility?: string | null;
      kind?: string | null;
    }>
  >("server_list_repos");
  const mapped: Repo[] = repos.map((repo) => ({
    repo_id: repo.repo_id || repo.id,
    user_id: "",
    name: repo.name,
    path: repo.path,
    visibility:
      repo.visibility === "public" || repo.visibility === "private"
        ? repo.visibility
        : undefined,
    kind: repo.kind === "folder" ? ("folder" as const) : ("git" as const),
  }));
  return wrapResponse<RepoList>({ repos: mapped });
}

/** Get repository by ID (path) */
export async function getRepoById(repoId: string) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind?: string | null;
  }>("server_get_repo", { repoId });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: result.kind === "folder" ? "folder" : "git",
  };
  return wrapResponse(repo);
}

/** Delete / unwatch repository */
export async function deleteRepo(repoId: string) {
  await invokeTauri<boolean>("server_delete_repo", { repoId });
  return wrapResponse(null);
}

/** Update repository visibility (public/private) by path */
export async function updateRepoVisibility(
  path: string,
  visibility: "public" | "private"
) {
  await invokeTauri("server_update_repo_visibility", { path, visibility });
}

/** Check GitHub repo visibility via backend (no CORS issues). Returns "public", "private", or null. */
export async function checkGithubVisibility(
  ownerRepo: string
): Promise<"public" | "private" | null> {
  const result = await invokeTauri<string | null>(
    "server_check_github_visibility",
    { ownerRepo }
  );
  if (result === "public" || result === "private") return result;
  return null;
}

// ============================================
// Repository Creation (via Tauri commands)
// ============================================

/** Import existing local Git repository */
export async function importLocalRepo(data: { fs_path: string }) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind?: string;
  }>("server_import_repo", { path: data.fs_path });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: result.kind === "folder" ? "folder" : "git",
  };
  return wrapResponse(repo);
}

/** Clone repository from GitHub URL */
export async function createFromGithub(data: {
  github_url: string;
  fs_path: string;
}) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind?: string;
  }>("server_clone_github", {
    url: data.github_url,
    targetDir: data.fs_path,
  });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: result.kind === "folder" ? "folder" : "git",
  };
  return wrapResponse(repo);
}

/** Create a new empty repository */
export async function createEmptyRepo(data: {
  name: string;
  description?: string;
  fs_path: string;
  init_with_readme?: boolean;
}) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind?: string;
  }>("server_create_empty_repo", {
    path: data.fs_path,
    name: data.name,
  });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: result.kind === "folder" ? "folder" : "git",
  };
  return wrapResponse(repo);
}

/** Import existing local folder as a work folder (no git) */
export async function importWorkFolder(data: { fs_path: string }) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind: string;
  }>("server_import_folder", { path: data.fs_path });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: "folder",
  };
  return wrapResponse(repo);
}

/** Create a new empty work folder (no git) */
export async function createWorkFolder(data: {
  name: string;
  fs_path: string;
}) {
  const result = await invokeTauri<{
    id: string;
    repo_id: string;
    name: string;
    path: string;
    kind: string;
  }>("server_create_folder", {
    path: data.fs_path,
    name: data.name,
  });
  const repo: Repo = {
    repo_id: result.repo_id || result.id,
    user_id: "",
    name: result.name,
    path: result.path,
    kind: "folder",
  };
  return wrapResponse(repo);
}

// ============================================
// IDE Detection (via Tauri command)
// ============================================

/** Detect installed IDEs on the system */
export async function detectIDEs() {
  const ides = await invokeTauri<
    Array<{
      id: string;
      name: string;
      installed: boolean;
      path?: string;
      category?: string;
    }>
  >("server_detect_ides");
  const mapped = ides.map((ide) => ({
    name: ide.name,
    path: ide.path || ide.id,
    id: ide.id,
    installed: ide.installed,
    category: ide.category ?? "ide",
  }));
  return wrapResponse({ ides: mapped, preferred_ide: null });
}

/**
 * Check if a directory is a git repository (has .git subdirectory).
 */
export async function validateWorkspacePath(path: string): Promise<string> {
  return invokeTauri<string>("server_validate_workspace_path", { path });
}

export async function checkIsGitRepo(path: string): Promise<boolean> {
  return invokeTauri<boolean>("server_check_is_git_repo", { path });
}

// ============================================
// Export
// ============================================

export const repoApi = {
  // Repository List
  getRepos,
  getRepoById,

  // Create Repository
  importLocalRepo,
  createFromGithub,
  createEmptyRepo,

  // Work Folders
  importWorkFolder,
  createWorkFolder,

  // Detection
  validateWorkspacePath,
  checkIsGitRepo,

  // Delete Repository
  deleteRepo,

  // Update
  updateRepoVisibility,

  // IDE Detection
  detectIDEs,
};

export default repoApi;
