export interface GitHubRepoNetworkIdentity {
  full_name: string;
  source_full_name: string;
}

export interface GitHubRepoPermissions {
  role_name: string | null;
  can_manage_issues: boolean;
  can_manage_pull_requests: boolean;
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
