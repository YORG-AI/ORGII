/**
 * Unified Activity Data Library
 *
 * Single source of truth for activity data normalization and extraction.
 * Consolidates logic from:
 * - EventSystem/adapters/ActivityAdapter.ts
 * - ChatPanel/ChatHistory/utils/extractors.ts
 * - util/session/activityConverter.ts
 *
 * @example
 * ```typescript
 * import { normalizeActivity, normalizeFunctionName } from "@src/lib/activityData";
 *
 * const normalized = normalizeActivity(rawEvent);
 * const uiCanonical = normalizeFunctionName("Read"); // → "read_file"
 * ```
 */

// ============================================
// Normalizers
// ============================================
export {
  // Main normalization function
  normalizeActivity,
} from "./activityNormalizers";

// ============================================
// Text Extractors
// ============================================
export {
  extractTextFromContent,
  isOrchestratorSystemPrompt,
} from "./textExtractors";
