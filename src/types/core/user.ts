/**
 * User Types
 *
 * Consolidated user-related type definitions.
 * Merged from: shared/user.ts + userProfile.ts
 */

// ============================================
// Account Types (from shared/user.ts)
// ============================================

export type ISetUserAPIKeyParam = {
  user_id: string;
  openai_api_key?: string;
  deepseek_api_key?: string;
  login_token?: string;
};

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
