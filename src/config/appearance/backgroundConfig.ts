/**
 * Background configuration utilities shared across the store layer and the
 * Settings BackgroundPage UI.
 *
 * Lives here so that shared atoms in src/store/ do not need to import from
 * a Settings sub-page module.
 */
// ─── Utilities ───────────────────────────────────────────────────────────────

/** Normalize #rgb / #rrggbb to lowercase #rrggbb. Returns null for invalid input. */
export function normalizeHexColor(input: string): string | null {
  const trimmed = input.trim();
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (!match) return null;
  const body = match[1];
  const expanded =
    body.length === 3
      ? body
          .split("")
          .map((ch) => ch + ch)
          .join("")
      : body;
  return `#${expanded.toLowerCase()}`;
}

/** Dedupe while preserving order. Filters out non-strings and invalid hex values. */
export function sanitizeCustomColorsArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeHexColor(entry);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}
