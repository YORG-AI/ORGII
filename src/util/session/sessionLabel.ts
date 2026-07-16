import { SESSION_CONFIG } from "@src/features/SessionCreator/config";

import { stripPillReferences } from "./stripPillReferences";

/**
 * Build a short display label for a session.
 * Used by session tabs, panel titles, and anywhere a session
 * needs a human-readable name.
 *
 * @param maxLength - truncation limit (default 30)
 */
export function sessionLabel(
  session: { name?: string; user_input?: string; displayLabel?: string },
  maxLength = 30
): string {
  const displayName =
    session.name && session.name !== SESSION_CONFIG.DEFAULT_SESSION_NAME
      ? session.name
      : undefined;
  const generatedDisplayLabel = session.displayLabel?.trim() || undefined;
  const rawInput =
    displayName ||
    generatedDisplayLabel ||
    session.user_input?.slice(0, 80) ||
    "Untitled";
  return stripPillReferences(rawInput).slice(0, maxLength) || "Untitled";
}
