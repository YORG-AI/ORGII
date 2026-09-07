/**
 * Repo Store Types
 *
 * Type definitions for the repo store.
 */

// ============================================
// Core Types
// ============================================

/** Distinguishes git repositories from plain work folders */
export const REPO_KIND = {
  GIT: "git",
  FOLDER: "folder",
} as const;

export type RepoKind = (typeof REPO_KIND)[keyof typeof REPO_KIND];

/** Repository information */
export interface Repo {
  id: string;
  name: string;
  path?: string; // File system path (for Rust Git API)
  visibility?: "public" | "private";
  kind: RepoKind;
  description?: string;
  repo_url?: string;
  branch?: string;
  fs_uri?: string;
  owner_user_id?: string;
  project_collection_uuid?: string;
  workspace_uuid?: string;
  created_at?: string;
  updated_at?: string;
  stats?: {
    sessions?: number;
    linked_stories?: number;
    work_items?: number;
    context_items?: number;
  };
}

/** Branch information */
export interface Branch {
  name: string;
  lastCommitDate?: string;
  isRemote?: boolean;
  isCurrent?: boolean;
}

// ============================================
// Cache Types
// ============================================

/** Cached repo (minimal data for quick restore) */
export interface CachedRepo {
  id: string;
  name: string;
  path: string;
  repo_url?: string;
}

/** Branch cache entry */
export interface BranchCacheEntry {
  branches: Branch[];
  currentBranch: string;
  fetchedAt: number;
}

// ============================================
// Constants
// ============================================

/** LRU Cache Configuration */
export const BRANCH_CACHE_CONFIG = {
  MAX_SIZE: 20, // Maximum 20 repos cached (prevents memory bloat)
  TTL: 5 * 60 * 1000, // 5 minutes
} as const;

/** Maximum number of cached repos for quick restore / recent repos display */
export const MAX_CACHED_REPOS = 7;
