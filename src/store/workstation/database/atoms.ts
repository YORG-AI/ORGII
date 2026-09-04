/**
 * Database connection persistence helpers
 *
 * Persistence: Stores connection configs in localStorage so they can be
 * reopened on app restart. The actual database service instances are
 * recreated from configs.
 */
import type { DatabaseConnectionConfig } from "@src/engines/DatabaseCore";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("Database");

// ============================================
// Storage Keys
// ============================================

const STORAGE_KEY_V2 = "orgii:database-connection-configs";

// ============================================
// Config Persistence
// ============================================

/**
 * Load connection configs from localStorage
 * Supports all database types (SQLite, PostgreSQL, MySQL, Supabase, Neon, Turso)
 */
export function loadConnectionConfigs(): DatabaseConnectionConfig[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_V2);
    if (stored) {
      return JSON.parse(stored) as DatabaseConnectionConfig[];
    }
  } catch (error) {
    log.warn("Failed to load connection configs:", error);
  }
  return [];
}

/**
 * Save connection configs to localStorage
 */
export function saveConnectionConfigs(
  configs: DatabaseConnectionConfig[]
): void {
  try {
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(configs));
  } catch (error) {
    log.warn("Failed to save connection configs:", error);
  }
}

/**
 * Add a new connection config
 */
export function addConnectionConfig(
  config: DatabaseConnectionConfig
): DatabaseConnectionConfig[] {
  const configs = loadConnectionConfigs();
  // Check for duplicate
  const exists = configs.some((existing) => existing.id === config.id);
  if (!exists) {
    configs.push(config);
    saveConnectionConfigs(configs);
  }
  return configs;
}

/**
 * Remove a connection config by ID
 */
export function removeConnectionConfig(
  connectionId: string
): DatabaseConnectionConfig[] {
  const configs = loadConnectionConfigs();
  const filtered = configs.filter((config) => config.id !== connectionId);
  saveConnectionConfigs(filtered);
  return filtered;
}

/**
 * Update a connection config
 */
export function updateConnectionConfig(
  connectionId: string,
  updates: Partial<DatabaseConnectionConfig>
): DatabaseConnectionConfig[] {
  const configs = loadConnectionConfigs();
  const index = configs.findIndex((config) => config.id === connectionId);
  if (index !== -1) {
    configs[index] = {
      ...configs[index],
      ...updates,
      updatedAt: Date.now(),
    } as DatabaseConnectionConfig;
    saveConnectionConfigs(configs);
  }
  return configs;
}

// ============================================
// Pending Changes Helper Functions
// ============================================

/** Generate a unique change ID */
export function generateChangeId(): string {
  return `change-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
