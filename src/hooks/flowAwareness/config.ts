/**
 * Flow Awareness configuration constants.
 *
 * This module contains all configuration values used by the flow awareness system,
 * making them easily adjustable and providing a single source of truth.
 */

/** Performance and batching configuration for flow awareness tracking. */
export const FLOW_AWARENESS_CONFIG = {
  /** Minimum interval between duplicate activities to prevent spam (ms). */
  DEBOUNCE_INTERVAL_MS: 500,

  /** Maximum pending activities before immediate flush to backend. */
  MAX_PENDING_ACTIVITIES: 10,

  /** Regular flush interval for batched activities (ms). */
  FLUSH_INTERVAL_MS: 2000,

  /** Maximum activities in a single Tauri command call to avoid IPC limits. */
  MAX_BATCH_SIZE: 50,

  /** Default maximum activities for context queries. */
  DEFAULT_MAX_ACTIVITIES: 20,

  /** Maximum preview length for clipboard content (characters). */
  MAX_PREVIEW_LENGTH: 200,

  /** Timeout for Tauri command calls (ms). */
  COMMAND_TIMEOUT_MS: 5000,

  /** Enable detailed logging for debugging purposes. */
  DEBUG_LOGGING: process.env.NODE_ENV === "development",
} as const;
