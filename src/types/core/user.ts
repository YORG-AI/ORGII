/**
 * User Types
 *
 * Consolidated user-related type definitions.
 * Merged from: shared/user.ts + userProfile.ts
 */

// ============================================
// Account Types (from shared/user.ts)
// ============================================

export type IUserInfo = {
  uuid: string;
  name: string;
  authing_id: string;
  profile: string;
  picture: string;
  profile_image_url: string;
  openai_api_key: string;
  deepseek_api_key: string;
  git_user_name: string;
  git_user_email: string;
  github_infos: IGithubAccount[];
  gitlab_infos: IGitlabAccount[];

  // Market fields
  provider_id?: string;
  consumer_id?: string;
  role?: "consumer" | "provider" | "both";
  stripe_account_status?: string;
  stripe_onboarding_complete?: boolean;
  wallet_balance?: number;
};

export type IGithubAccount = {
  uuid: string;
  user_name: string;
  token_type: "GithubApp" | "Classic";
  oauth_token: string;
};

export type IGitlabAccount = {
  uuid: string;
  user_name: string;
  token_type: "GitLabApp" | "Classic";
  oauth_token: string;
};

// ============================================
// User Profile Types (from userProfile.ts)
// ============================================

export interface LanguageStats {
  language: string;
  percentage: number;
  repos_count: number; // Backend uses repos_count (aliased from "repos")
  bytes: number;
}

export interface LanguageBreakdown {
  [language: string]: {
    percentage: number;
    bytes: number;
    repos: number; // Backend uses "repos" in language_breakdown
  };
}

export interface SpecialtyScores {
  frontend?: number;
  backend?: number;
  fullstack?: number;
  mobile?: number;
  devops?: number;
  data?: number;
  systems?: number;
  ml_ai?: number;
  web3?: number;
  game_dev?: number;
  other?: number;
}

export type Specialty =
  | "frontend"
  | "backend"
  | "fullstack"
  | "mobile"
  | "devops"
  | "data"
  | "systems"
  | "ml_ai"
  | "web3"
  | "game_dev"
  | "other";

export type ActivityLevel =
  | "very_high"
  | "high"
  | "moderate"
  | "low"
  | "inactive";

export interface UserProfileData {
  user_id: string;
  display_name?: string;
  avatar_url?: string;
  source_usernames?: Record<string, string>; // e.g. { "github": "octocat" }

  // Repository stats
  total_repos: number;
  public_repos: number;
  private_repos: number;

  // Commit stats - direct from backend
  total_commits: number;
  years_active: number; // Backend returns integer
  first_commit_date?: string;
  last_commit_date?: string;
  commits_last_year: number; // Direct from backend
  commits_last_month: number; // Direct from backend
  avg_commits_per_week: number; // Direct from backend

  // Derived years array (computed from commits_by_year keys)
  years_active_array?: string[];

  // Timeline
  commits_by_year: Record<string, number>;

  // Languages - backend returns both
  top_languages: LanguageStats[];
  language_breakdown?: LanguageBreakdown;
  primary_language?: string;

  // Specialty detection
  specialty: {
    primary: Specialty;
    confidence: number;
    scores: SpecialtyScores;
    reasoning?: string;
  };

  // Activity metrics
  activity_level: ActivityLevel;
  consistency_score?: number;

  // Sources
  connected_sources?: Record<string, boolean>;

  // Top repositories (from local GitHub fetch)
  top_repos?: RepoActivity[];

  // GitHub profile fields (from /user API)
  bio?: string;
  location?: string;
  blog?: string;
  company?: string;

  // Cache metadata
  last_updated: string;
  cache_valid_until: string;
}

export interface ChartDataset {
  label: string;
  data: number[];
  backgroundColor?: string | string[];
  borderColor?: string;
  borderWidth?: number;
  tension?: number;
  fill?: boolean;
}

export interface ChartData {
  type: "line" | "bar" | "doughnut" | "pie";
  labels: string[];
  datasets: ChartDataset[];
}

export interface CommitHistoryChartData extends ChartData {
  total_commits: number;
  avg_commits_per_year: number;
}

export interface LanguageChartData extends ChartData {
  diversity_score: number;
  total_languages: number;
}

// ============================================
// TOP REPOSITORIES TYPES
// ============================================

export type TopReposSortBy = "commits" | "recent" | "activity";

export interface RepoActivity {
  repo_name: string;
  repo_full_name: string;
  repo_url: string;
  is_private: boolean;
  commit_count: number;
  lines_added: number;
  lines_deleted: number;
  primary_language: string | null;
  description: string | null;
  last_commit_date: string | null;
  first_commit_date: string | null;
  activity_score: number;
}
