/**
 * GitHub API — shared types
 *
 * Types (mirror Rust-side structs) that are shared across more than one
 * `github/*` domain module (e.g. `GitHubIssueUser` is used by both PR
 * reviews and issues).
 */

export interface LocalGitHubRepo {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
}

export interface GitHubRepoNetworkIdentity {
  full_name: string;
  source_full_name: string;
}

export interface GitHubRepoPermissions {
  role_name: string | null;
  can_manage_issues: boolean;
  can_manage_pull_requests: boolean;
}

export interface LocalGitHubBranch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface LocalPRResponse {
  number: number;
  url: string;
}

export interface LocalFindPRResponse {
  number: number;
  url: string;
  state: string;
}

export interface GitHubGitCredential {
  username: string;
  token: string;
  repo_full_name: string;
}

/** Generic Git credential resolved from `connection_token_store`. */
export interface GitCredential {
  connection_id: string;
  username: string;
  token: string;
  source: string;
}

export interface ProfileData {
  user: Record<string, unknown>;
  repos: Record<string, unknown>[];
  languages: { language: string; bytes: number; percentage: number }[];
  commit_history: { year: number; total_commits: number }[];
  top_repos: Record<string, unknown>[];
}

export interface GhCliCredential {
  username: string;
  token: string;
}

export interface SshKeyInfo {
  filename: string;
  key_type: string;
  comment: string;
}

export interface CredentialHelperInfo {
  helper: string;
  username: string | null;
  token: string | null;
}

export interface DetectedGitHubCredentials {
  gh_cli: GhCliCredential | null;
  ssh_keys: SshKeyInfo[];
  credential_helper: CredentialHelperInfo | null;
  git_credentials_has_github: boolean;
}

export interface GitHubIssueUser {
  login: string;
  avatar_url: string;
}
