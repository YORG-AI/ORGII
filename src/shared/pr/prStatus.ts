/**
 * Shared, cross-surface helpers for pull-request status.
 *
 * Consolidates the four duplicated status maps that previously lived in:
 *   - `workstationPrHelpers.normalizePullRequestStatus`
 *   - `PullRequestContent.normalizeStatus`
 *   - `prCardHelpers.getPrStatusVariant`
 *   - `PrSection.PR_STATUS_COLORS`
 *   - `SessionLinkCard.getStatusBadgeConfig`
 *
 * This module is intentionally free of React / i18n so it can be unit-tested
 * in isolation. Components map the returned class strings onto design-system
 * tokens, the label key onto `t(...)`, and the icon name onto a real icon.
 *
 * Semantic colors per PR state (kept consistent across every surface):
 *   open → success (green), merged → GitHub purple, closed → danger (red),
 *   draft → neutral secondary text, unknown → neutral muted text.
 */
import type { PrStatus } from "@src/api/http/project/types/agentWorkflow";

/** Visual variant (badge + status dot) for a normalized PR status. */
export interface PrStatusVariant {
  /** Tailwind classes for the badge pill background + text color. */
  badgeClass: string;
  /** Tailwind classes for the small leading status dot. */
  dotClass: string;
  /** Tailwind class for status text and status glyphs. */
  textClass: string;
}

/**
 * Semantic icon identifier for a PR status. Kept as a string (not a React
 * node) so this module stays pure; consumers map it onto a real icon
 * component. Extend the union + map below when a surface needs a new glyph.
 */
export type PrStatusIconName = "pull-request" | "merge" | "closed" | "draft";

const PR_STATUS_VARIANTS: Record<string, PrStatusVariant> = {
  open: {
    badgeClass: "bg-success-1 text-success-6",
    dotClass: "bg-success-6",
    textClass: "text-success-6",
  },
  merged: {
    badgeClass: "bg-purple-1 text-purple-6",
    dotClass: "bg-purple-6",
    textClass: "text-purple-6",
  },
  closed: {
    badgeClass: "bg-danger-1 text-danger-6",
    dotClass: "bg-danger-6",
    textClass: "text-danger-6",
  },
  draft: {
    badgeClass: "bg-fill-2 text-text-2",
    dotClass: "bg-text-2",
    textClass: "text-text-2",
  },
};

/** Neutral fallback for unknown / custom states (e.g. "pending_review"). */
const FALLBACK_STATUS_VARIANT: PrStatusVariant = {
  badgeClass: "bg-fill-2 text-text-3",
  dotClass: "bg-text-3",
  textClass: "text-text-3",
};

const PR_STATUS_ICONS: Record<string, PrStatusIconName> = {
  open: "pull-request",
  draft: "draft",
  merged: "merge",
  closed: "closed",
};

/**
 * Normalize a raw PR shape into a canonical status string.
 *
 * `merged` overrides `draft`, which overrides `state`. Known GitHub states
 * are lowercased to one of the {@link PrStatus} values. Unknown / custom
 * states are passed through as their lowercased form so callers can still
 * render them, and a missing/null state defaults to `"open"` (an existing PR
 * with no state field is assumed open). Returns `string` rather than
 * `PrStatus` precisely so this pass-through behavior is preserved.
 */
export function normalizePrStatus(input: {
  state?: string | null;
  merged?: boolean;
  draft?: boolean;
}): string {
  const { state, merged, draft } = input;
  if (merged) return "merged";
  if (draft) return "draft";
  const normalized = state?.toLowerCase();
  if (
    normalized === "open" ||
    normalized === "merged" ||
    normalized === "closed" ||
    normalized === "draft"
  ) {
    return normalized;
  }
  return normalized || "open";
}

/** Resolve a normalized status key to its badge + dot classes. */
export function getPrStatusVariant(status: string): PrStatusVariant {
  return PR_STATUS_VARIANTS[status] ?? FALLBACK_STATUS_VARIANT;
}

/**
 * i18n key for a PR status label, relative to the `common` namespace
 * (e.g. `labels.prStatus.open`). Never returns hardcoded English.
 *
 * **Required i18n namespace:** `common` — callers must obtain `t` via
 * `useTranslation("common")` (or equivalent) before passing the returned key
 * to `t(...)`. The key will not resolve correctly in any other namespace.
 */
export function getPrStatusLabelKey(status: string): string {
  return `labels.prStatus.${status}`;
}

/** Semantic icon name for a PR status (defaults to "pull-request"). */
export function getPrStatusIconName(status: string): PrStatusIconName {
  return PR_STATUS_ICONS[status] ?? "pull-request";
}

/** Re-exported for convenience so consumers can import the type alongside helpers. */
export type { PrStatus };
