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
