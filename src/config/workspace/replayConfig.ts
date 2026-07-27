/**
 * Replay Configuration Constants
 *
 * Centralized configuration for replay bar behavior.
 * Separate file to avoid circular dependencies.
 */

/** Playback speed multipliers shown in replay UI (max 6x). */
export const REPLAY_SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 6] as const;

export type ReplaySpeed = (typeof REPLAY_SPEED_OPTIONS)[number];

/** Default playback speed for session simulator and Dev Journey replay bars. */
export const DEFAULT_REPLAY_SPEED = 1;

export const REPLAY_CONFIG = {
  /** Maximum value for the replay slider (0-200 range) */
  MAX_VALUE: 200,
  /** Step size for skip forward/backward buttons */
  SKIP_STEP: 20,
  /** Threshold from max value to consider "at end" (for auto-follow mode) */
  AT_END_THRESHOLD: 5,
  /** Timeout (ms) before resetting replay mode after user interaction */
  REPLAY_MODE_TIMEOUT: 5000,
} as const;

/** Type for REPLAY_CONFIG values */
export type ReplayConfigType = typeof REPLAY_CONFIG;
