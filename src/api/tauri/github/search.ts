/**
 * GitHub API — public repository search
 */
import { invoke } from "@tauri-apps/api/core";

export interface SearchRepo {
  id: number;
  full_name: string;
  name: string;
  owner_login: string;
  owner_avatar_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  html_url: string;
  clone_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  license: string | null;
  topics: string[];
  updated_at: string;
}

export type RepoSearchSort = "best_match" | "stars" | "forks" | "updated";

export interface RepoSearchResponse {
  items: SearchRepo[];
  total_count: number;
  incomplete_results: boolean;
  /**
   * Whether the request reused the user's connection token. `false`
   * means we hit the unauthenticated 10 req/min rate limit; the
   * Explore page warns the user when this is false.
   */
  authenticated: boolean;
}

/**
 * Search GitHub public repositories. Reuses the user's token when
 * available, falls back to unauthenticated requests otherwise.
 * Note: this command intentionally does not use `invokeWithAuth` —
 * unauthenticated mode is a valid response, not a re-auth condition.
 */
export async function searchReposLocal(
  query: string,
  opts?: { sort?: RepoSearchSort; page?: number; perPage?: number }
): Promise<RepoSearchResponse> {
  return invoke<RepoSearchResponse>("github_search_repos", {
    query,
    sort: opts?.sort ?? null,
    page: opts?.page ?? null,
    perPage: opts?.perPage ?? null,
  });
}
