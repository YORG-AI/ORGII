/**
 * Skin type vocabulary.
 *
 * A *skin* is a named palette seed, not a stylesheet. Each variant carries the
 * five values every downstream token is derived from — `surface`, `ink`,
 * `accent`, `contrast`, plus semantic diff/skill hues — and an optional syntax
 * palette for code surfaces. `deriveSkinTokens` turns a seed into the concrete
 * `--color-*` / `--cm-*` custom properties the app paints with.
 *
 * The seed shape mirrors the `codex-theme-v1` schema so themes exported from
 * the Codex app can be adopted without a lossy translation step.
 */

export const SKIN_VARIANTS = ["light", "dark"] as const;

export type SkinVariant = (typeof SKIN_VARIANTS)[number];

/** Syntax token colors, keyed to the `--cm-syntax-*` custom properties. */
interface SkinSyntaxPalette {
  comment: string;
  string: string;
  keyword: string;
  function: string;
  variable: string;
  number: string;
  operator: string;
  tag: string;
  attribute: string;
  property: string;
  type: string;
  constant: string;
  invalid: string;
}

/** Diff and skill hues that must stay recognizable independent of the accent. */
interface SkinSemanticColors {
  diffAdded: string;
  diffRemoved: string;
  skill: string;
}

export interface SkinSeed {
  /** Base background. Everything from `--color-bg-*` down is mixed from this. */
  surface: string;
  /** Base foreground. Drives the `--color-text-*` ramp. */
  ink: string;
  /** The skin's own accent, used when the accent preset is `matchSkin`. */
  accent: string;
  /**
   * 0–100. Higher pulls secondary/tertiary text and borders further from the
   * surface. Codex defaults to 45 for light and 60 for dark.
   */
  contrast: number;
  semanticColors: SkinSemanticColors;
  syntax: Partial<SkinSyntaxPalette>;
}

interface SkinVariantDefinition {
  seed: SkinSeed;
  /** Upstream theme name this variant was derived from, for attribution. */
  sourceName?: string;
}

type SkinSource = "orgii" | "codex";

export interface SkinDefinition {
  id: string;
  label: string;
  source: SkinSource;
  /**
   * Skins built into the base stylesheets (`orgii_main.css` / `orgii_dark.css`).
   * These emit no token overrides at all, so the shipped design system stays the
   * single source of truth for the default look.
   */
  isBaseline?: boolean;
  variants: Partial<Record<SkinVariant, SkinVariantDefinition>>;
}
