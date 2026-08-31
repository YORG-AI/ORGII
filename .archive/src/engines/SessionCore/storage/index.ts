/**
 * Session Storage Module
 *
 * Handles persistence for session data via Rust SQLite (Tauri).
 *
 * Use `cacheAdapter` as the primary interface.
 */

// Unified cache adapter
export { cacheAdapter } from "./cacheAdapter";
export type { CacheStats, SearchResult } from "./cacheAdapter";

// SQLite backend (direct access if needed)
export { sqliteCache } from "./sqliteCache";
export type { TruncateResult } from "./sqliteCache";
