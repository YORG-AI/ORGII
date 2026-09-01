/**
 * Imperative skin-token application, usable outside React.
 *
 * A variant flip is a two-part operation: the base stylesheet swaps *and* the
 * skin's inline tokens change. React drives the second half one tick after the
 * first, which leaves at least one painted frame where, say, the dark
 * stylesheet is live while the light skin's surfaces still override it. Under a
 * theme-transition cover that frame is exactly what the cover was supposed to
 * hide.
 *
 * So every path that swaps the stylesheet applies the matching tokens here, in
 * the same tick as the promotion. `useAppSkin` still applies them on state
 * change; the two are idempotent, and whichever runs second writes identical
 * values.
 *
 * Selections are read from the persisted skin mirror rather than from React, so
 * this also works before the app has mounted (see `themeInit`).
 */
import { COLOR_PRIMARY_VARIABLE_KEYS } from "@src/config/appearance/primaryColors";
import { normalizeAccentPreset } from "@src/config/appearance/skins/accent";
import { resolveAppliedSkinTokens } from "@src/config/appearance/skins/appliedTokens";
import { SKIN_TOKEN_KEYS } from "@src/config/appearance/skins/deriveSkinTokens";
import { resolveSkinId } from "@src/config/appearance/skins/registry";
import type { SkinVariant } from "@src/config/appearance/skins/types";

/**
 * Mirror of the user's skin and accent selection, kept in `localStorage` so
 * both this module and the pre-bundle splash script in `public/index.html` can
 * read it without the settings file or React.
 */
export const SKIN_SELECTION_STORAGE_KEY = "orgii_skin_selection";

export interface SkinSelection {
  skinId: string;
  accent: string;
}

export type SkinSelectionMirror = Record<SkinVariant, SkinSelection>;

/** Every property this module owns, for exhaustive teardown. */
export const OWNED_SKIN_TOKEN_KEYS: readonly string[] = Array.from(
  new Set<string>([...SKIN_TOKEN_KEYS, ...COLOR_PRIMARY_VARIABLE_KEYS])
);

export function readSkinSelection(variant: SkinVariant): SkinSelection | null {
  try {
    const stored = localStorage.getItem(SKIN_SELECTION_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<SkinSelectionMirror>;
    const entry = parsed?.[variant];
    if (!entry || typeof entry.skinId !== "string") return null;
    return { skinId: entry.skinId, accent: String(entry.accent) };
  } catch {
    // Malformed or unavailable storage just means "no mirror yet".
    return null;
  }
}

export function writeSkinSelection(mirror: SkinSelectionMirror): void {
  try {
    localStorage.setItem(SKIN_SELECTION_STORAGE_KEY, JSON.stringify(mirror));
  } catch {
    // Restricted webview contexts have no storage; the mirror is an
    // optimization, never the source of truth.
  }
}

/** Write `tokens`, clearing any owned property the new set does not define. */
export function writeSkinTokens(tokens: Record<string, string>): void {
  const { body } = document;
  if (!body) return;
  for (const key of OWNED_SKIN_TOKEN_KEYS) {
    const value = tokens[key];
    if (value === undefined) body.style.removeProperty(key);
    else body.style.setProperty(key, value);
  }
}

export function clearSkinTokens(): void {
  const { body } = document;
  if (!body) return;
  for (const key of OWNED_SKIN_TOKEN_KEYS) {
    body.style.removeProperty(key);
  }
}

/**
 * Paint the skin for `variant` using the persisted selection.
 *
 * No-ops when no mirror exists yet (first ever launch), where the base
 * stylesheet is already the correct answer.
 */
export function applySkinTokensForVariant(variant: SkinVariant): void {
  const selection = readSkinSelection(variant);
  if (!selection) return;
  const skinId = resolveSkinId(selection.skinId, variant);
  writeSkinTokens(
    resolveAppliedSkinTokens(
      skinId,
      variant,
      normalizeAccentPreset(selection.accent)
    )
  );
  document.documentElement.dataset.skin = skinId;
}
