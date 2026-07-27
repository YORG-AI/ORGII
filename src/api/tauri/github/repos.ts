/**
 * GitHub API — repositories, branches, clone
 */
import { invoke } from "@tauri-apps/api/core";

import { invokeWithAuth } from "./client";
import type {
  GitHubRepoNetworkIdentity,
  LocalGitHubBranch,
  LocalGitHubRepo,
} from "./types";

export async function listReposLocal(
  page?: number,
  perPage?: number
): Promise<LocalGitHubRepo[]> {
  return invokeWithAuth<LocalGitHubRepo[]>("github_list_repos", {
    page: page ?? null,
    perPage: perPage ?? null,
  });
}

export async function resolveGitHubRepoNetworkIdentityLocal(
  repoFullName: string
): Promise<GitHubRepoNetworkIdentity> {
  return invoke<GitHubRepoNetworkIdentity>(
    "github_resolve_repo_network_identity",
    { repoFullName }
  );
}

export async function listBranchesLocal(
  repoFullName: string
): Promise<LocalGitHubBranch[]> {
  return invokeWithAuth<LocalGitHubBranch[]>("github_list_branches", {
    repoFullName,
  });
}

export async function createBranchLocal(
  repoFullName: string,
  branchName: string,
  fromSha: string
): Promise<string> {
  return invokeWithAuth<string>("github_create_branch", {
    repoFullName,
    branchName,
    fromSha,
  });
}

export async function cloneRepoLocal(
  repoFullName: string,
  targetDir: string,
  branch?: string
): Promise<string> {
  return invokeWithAuth<string>("github_clone_repo", {
    repoFullName,
    targetDir,
    branch: branch ?? null,
  });
}
