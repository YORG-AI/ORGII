/**
 * Pure presentation helpers for the sidebar PR summary card.
 *
 * These are intentionally free of React / i18n so they can be unit-tested in
 * isolation (see __tests__/prCardHelpers.test.ts). The component layer maps
 * the returned class strings / labels onto design-system tokens and t(...).
 *
 * The cross-surface PR-status palette and stat-number formatter now live in
 * `@src/shared/pr`; they are re-exported here so existing imports keep working.
 */
export {
  type PrStatusVariant,
  getPrStatusIconName,
  getPrStatusVariant,
} from "@src/shared/pr/prStatus";
export { formatStatNumber } from "@src/shared/pr/formatStatNumber";

/**
 * Hard cap on a branch label's character length as a safety net for
 * pathologically long names. Normal responsive truncation is handled by CSS
 * (`truncate`); this prevents enormous DOM text nodes and keeps the full name
 * available via the `title` tooltip.
 */
export function truncateBranchLabel(branch: string, max = 80): string {
  const trimmed = (branch ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
