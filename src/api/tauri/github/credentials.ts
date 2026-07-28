/**
 * GitHub API — git credential resolution, token check, profile, and
 * local-credential detection
 */
import { invoke } from "@tauri-apps/api/core";

import { invokeWithAuth } from "./client";
import type {
  DetectedGitHubCredentials,
  GitCredential,
  GitHubGitCredential,
  ProfileData,
} from "./types";

/**
 * GitHub-flavored credential lookup. Returns the active token paired
 * with the inferred `owner/repo` for the given remote, or `null` when
 * the remote is not a GitHub URL or no credential is on file.
 */
export async function getGitHubGitCredentialForRemote(
  remoteUrl: string
): Promise<GitHubGitCredential | null> {
  return invoke<GitHubGitCredential | null>(
    "github_git_credential_for_remote",
    { remoteUrl }
  );
}

/**
 * Generic Git credential lookup against `connection_token_store`. Returns
 * `null` for SSH-only remotes (handled by the system `git` config) or
 * when no HTTPS credential is on file.
 */
export async function getGitCredentialForRemote(
  remoteUrl: string
): Promise<GitCredential | null> {
  return invoke<GitCredential | null>("git_credential_for_remote", {
    remoteUrl,
  });
}

export async function checkTokenLocal(): Promise<boolean> {
  return invokeWithAuth<boolean>("github_check_token", {});
}

export async function fetchProfileLocal(): Promise<ProfileData> {
  return invokeWithAuth<ProfileData>("github_fetch_profile", {});
}

export async function detectGitHubCredentials(): Promise<DetectedGitHubCredentials> {
  return invoke<DetectedGitHubCredentials>("detect_github_credentials");
}
