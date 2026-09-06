/**
 * Session Helpers
 *
 * Utility functions for session ID validation and localStorage persistence.
 */
import "@src/hooks/logger";

import "./atoms";

/**
 * Validate if a string is a valid UUID
 */
export const isValidSessionUUID = (id: string): boolean => {
  if (!id) return false;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
};
