/**
 * Git Remotes API
 *
 * Remote repository management functions.
 */
import { createLogger } from "@src/hooks/logger";

import { fetchRustApi, gitRepoUrl } from "./client";
import type {
  GitCredentialFillResponse,
  GitRemoteInfo,
  GitRemotesResponse,
} from "./types";

const log = createLogger("GitAPI");

/**
 * Get all configured remotes
 * Uses Rust HTTP server for better performance
 */
export const getGitRemotes = async (params: {
  repo_id: string;
  repo_path?: string;
}): Promise<GitRemotesResponse["data"] | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  try {
    const response = await fetchRustApi<GitRemotesResponse["data"]>(
      `${gitRepoUrl(params.repo_id)}/remotes${queryParams.toString() ? `?${queryParams.toString()}` : ""}`
    );
    return response.data;
  } catch (error) {
    // "Not a git repository" / unknown repo path are DEFINITIVE answers, not
    // transport failures: the directory can never yield a remote. Return an
    // empty remote list so callers (repoScopeResolver) cache the "no remote"
    // result instead of retrying forever — a plain-folder workspace row used
    // to sit on "resolving…" indefinitely because every retry 404'd.
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repositor|repo.*not found|invalid path/i.test(message)) {
      return { remotes: [] };
    }
    log.error("[GitAPI] Failed to fetch remotes from Rust server:", error);
    return undefined;
  }
};

export const fillGitCredentials = async (params: {
  repo_id: string;
  repo_path?: string;
  remoteUrl: string;
}): Promise<GitCredentialFillResponse["data"] | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  const response = await fetchRustApi<GitCredentialFillResponse["data"]>(
    `${gitRepoUrl(params.repo_id)}/credentials/fill${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
    {
      method: "POST",
      body: JSON.stringify({ remote_url: params.remoteUrl }),
    }
  );
  return response.data;
};

/**
 * Add a new remote
 * Uses Rust HTTP server
 */
export const addGitRemote = async (params: {
  repo_id: string;
  repo_path?: string;
  name: string;
  url: string;
}): Promise<GitRemoteInfo | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  try {
    const response = await fetchRustApi<GitRemoteInfo>(
      `${gitRepoUrl(params.repo_id)}/remotes${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
      {
        method: "POST",
        body: JSON.stringify({
          name: params.name,
          url: params.url,
        }),
      }
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to add remote:", error);
    return undefined;
  }
};

/**
 * Update remote URL
 * Uses Rust HTTP server
 */
export const updateGitRemote = async (params: {
  repo_id: string;
  repo_path?: string;
  remote_name: string;
  url: string;
}): Promise<GitRemoteInfo | undefined> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  try {
    const response = await fetchRustApi<GitRemoteInfo>(
      `${gitRepoUrl(params.repo_id)}/remotes/${encodeURIComponent(params.remote_name)}${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
      {
        method: "PUT",
        body: JSON.stringify({ url: params.url }),
      }
    );
    return response.data;
  } catch (error) {
    log.error("[GitAPI] Failed to update remote:", error);
    return undefined;
  }
};

/**
 * Delete a remote
 * Uses Rust HTTP server
 */
export const deleteGitRemote = async (params: {
  repo_id: string;
  repo_path?: string;
  remote_name: string;
}): Promise<boolean> => {
  const queryParams = new URLSearchParams();
  if (params.repo_path) queryParams.append("path", params.repo_path);

  try {
    await fetchRustApi<void>(
      `${gitRepoUrl(params.repo_id)}/remotes/${encodeURIComponent(params.remote_name)}${queryParams.toString() ? `?${queryParams.toString()}` : ""}`,
      { method: "DELETE" }
    );
    return true;
  } catch (error) {
    log.error("[GitAPI] Failed to delete remote:", error);
    return false;
  }
};
