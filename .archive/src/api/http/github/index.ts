/**
 * GitHub integration HTTP helpers (hosted service `/github/*` routes).
 */
import {
  deleteHostedServiceApi as deleteApi,
  getHostedServiceApi as getApi,
  postHostedServiceApi as postApi,
} from "../client";
import type { GitHubBranch, GitHubConnection, GitHubRepo } from "./types";

export type { GitHubBranch, GitHubConnection, GitHubRepo } from "./types";

/**
 * Start GitHub connection flow
 */
export async function startGitHubConnect(
  userId: string
): Promise<{ connect_url: string; state: string }> {
  const response = await getApi<{ connect_url: string; state: string }>(
    `/github/connect?user_id=${userId}`
  );
  if (!response) {
    throw new Error("Failed to start GitHub connection");
  }
  return response.data as { connect_url: string; state: string };
}

/**
 * List GitHub connections
 */
export async function listGitHubConnections(
  userId: string
): Promise<GitHubConnection[]> {
  const response = await getApi<GitHubConnection[]>(
    `/github/connections?user_id=${userId}`
  );
  if (!response || response.status !== 0) return [];
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * List repos for a connection
 */
export async function listConnectionRepos(
  connectionId: string,
  refresh?: boolean
): Promise<GitHubRepo[]> {
  const response = await getApi<GitHubRepo[]>(
    `/github/connections/${connectionId}/repos${refresh ? "?refresh=true" : ""}`
  );
  if (!response || response.status !== 0) return [];
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * List branches for a repo
 */
export async function listRepoBranches(
  connectionId: string,
  repoFullName: string
): Promise<GitHubBranch[]> {
  const encodedRepoFullName = encodeURIComponent(repoFullName);
  const response = await getApi<GitHubBranch[]>(
    `/github/connections/${connectionId}/repos/${encodedRepoFullName}/branches`
  );
  if (!response || response.status !== 0) return [];
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Clone a GitHub repo
 */
export async function cloneGitHubRepo(data: {
  connection_id: string;
  repo_full_name: string;
  branch?: string;
}): Promise<{ repo_id: string }> {
  const response = await postApi<{ repo_id: string }>("/github/clone", data);
  if (!response) {
    throw new Error("Failed to clone GitHub repo");
  }
  return response.data as { repo_id: string };
}

/**
 * Create a branch
 */
export async function createGitHubBranch(data: {
  connection_id: string;
  repo_full_name: string;
  branch_name: string;
  from_branch?: string;
}): Promise<{ branch_name: string; sha: string }> {
  const response = await postApi<{ branch_name: string; sha: string }>(
    "/github/branches",
    data
  );
  if (!response) {
    throw new Error("Failed to create GitHub branch");
  }
  return response.data as { branch_name: string; sha: string };
}

/**
 * Delete a GitHub connection
 */
export async function deleteGitHubConnection(
  connectionId: string
): Promise<void> {
  await deleteApi<void>(`/github/connections/${connectionId}`);
}
