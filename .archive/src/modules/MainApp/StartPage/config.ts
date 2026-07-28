/**
 * SuggestionsPage Configuration
 *
 * Centralized configuration for constants and helpers
 */

// ============================================
// Constants
// ============================================

export const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export const normalizeTimestamp = (ts?: string): string =>
  ts || DEFAULT_TIMESTAMP;

// ============================================
// Greeting Helper
// ============================================

export type GreetingKey = "morning" | "afternoon" | "evening";

/**
 * Returns the i18n key for the current time-based greeting
 * Use with t(`greetings.${getGreetingKey()}`) from navigation namespace
 */
export const getGreetingKey = (): GreetingKey => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) {
    return "morning";
  } else if (hour >= 12 && hour < 18) {
    return "afternoon";
  } else {
    return "evening";
  }
};
