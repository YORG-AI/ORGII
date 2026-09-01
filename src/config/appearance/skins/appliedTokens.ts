/**
 * Resolve the exact custom properties the document should carry for a given
 * skin + accent selection.
 *
 * Split out from `useAppSkin` so the precedence rules are testable without a
 * DOM: the hook is then only responsible for writing (and clearing) what this
 * returns.
 */
import { type AccentPreset, resolveAccentPalette } from "./accent";
import { type SkinTokens, deriveSkinTokens } from "./deriveSkinTokens";
import { getSkinSeed, isBaselineSkin, resolveSkinId } from "./registry";
import type { SkinVariant } from "./types";

export function resolveAppliedSkinTokens(
  skinId: string,
  variant: SkinVariant,
  accentPreset: AccentPreset
): SkinTokens {
  // Resolve first: a dark-only skin stored as the light selection falls back to
  // the baseline, and must then behave like the baseline rather than being
  // re-derived from the baseline's own seed.
  const resolvedId = resolveSkinId(skinId, variant);

  // A baseline skin *is* the base stylesheet. Deriving tokens for it would
  // approximate a design that already ships exactly, so emit nothing and let
  // the stylesheet win.
  const tokens: SkinTokens = isBaselineSkin(resolvedId)
    ? {}
    : deriveSkinTokens(getSkinSeed(resolvedId, variant), variant);

  // `matchSkin` resolves to null: leave the primary ramp to the skin (or, for a
  // baseline skin, to the stylesheet).
  const accentPalette = resolveAccentPalette(accentPreset, variant);
  if (accentPalette) Object.assign(tokens, accentPalette);

  return tokens;
}
