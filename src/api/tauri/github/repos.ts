/**
 * GitHub API — repositories, branches, clone
 */
import { invoke } from "@tauri-apps/api/core";

import { invokeWithAuth } from "./client";
import type { GitHubRepoNetworkIdentity, GitHubRepoPermissions } from "./types";

export async function getGitHubRepoPermissionsLocal(
  repoFullName: string
): Promise<GitHubRepoPermissions> {
  return invokeWithAuth<GitHubRepoPermissions>("github_get_repo_permissions", {
    repoFullName,
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
