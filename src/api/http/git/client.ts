/**
 * Git API Client
 *
 * Base URL configuration, HTTP helpers, and request caching.
 */
import { IDE_SERVER_HTTP_URL } from "@src/config/ideServer";

// Rust HTTP Server (IDE server port) - Primary backend for all git operations
// Routes are nested under /git, so full path is /git/api/git/repo
export const RUST_GIT_BASE_URL = `${IDE_SERVER_HTTP_URL}/git/api/git/repo`;

/**
 * Build a repo-scoped URL with properly encoded repo_id.
 *
 * After the Python→Rust migration, repo_id is the filesystem path
 * (e.g. "/Users/me/project") which contains slashes. These must be
 * percent-encoded so Axum treats the repo_id as a single path segment.
 */
export function gitRepoUrl(repoId: string): string {
  return `${RUST_GIT_BASE_URL}/${encodeURIComponent(repoId)}`;
}

// ============================================================================
// Request Deduplication Cache
// ============================================================================

// Cache for in-flight requests to prevent duplicate API calls
export const branchRequestCache = new Map<string, Promise<unknown>>();
export const statusRequestCache = new Map<string, Promise<unknown>>();

// Cache cleanup helper - removes cache entry after a short delay
export const cleanupCache = (
  cache: Map<string, Promise<unknown>>,
  key: string
): void => {
  setTimeout(() => cache.delete(key), 100);
};

/**
 * Clear status cache for a specific repo (call before force refresh)
 * This ensures we get fresh data after git operations (push/pull/commit)
 */
export const clearStatusCache = (repoId?: string): void => {
  if (repoId) {
    const cacheKey = `status:${repoId}`;
    statusRequestCache.delete(cacheKey);
  } else {
    statusRequestCache.clear();
  }
};

// ============================================================================
// Rust HTTP API Helper
// ============================================================================

/**
 * Safely parse JSON from response text, returning undefined if empty or invalid
 */
function safeParseJson<T>(text: string): T | undefined {
  if (!text || text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Direct fetch to Rust HTTP server (primary backend for all git operations)
 */
export async function fetchRustApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ status: number; data: T }> {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // Always read body as text first to avoid JSON parse errors on empty responses
  const text = await response.text();

  if (!response.ok) {
    const error = safeParseJson<{ error?: string; message?: string }>(text);
    throw new Error(
      error?.error || error?.message || response.statusText || "Request failed"
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return { status: response.status, data: undefined as T };
  }

  // Parse successful response
  const parsed = safeParseJson<{ status: number; data: T }>(text);

  // If parsing succeeded and has expected structure, return it
  if (parsed && typeof parsed === "object") {
    return parsed;
  }

  // For empty or non-JSON responses, return undefined data
  return { status: response.status, data: undefined as T };
}
