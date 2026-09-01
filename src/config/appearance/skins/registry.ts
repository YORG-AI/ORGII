/**
 * Skin registry.
 *
 * Two families live here:
 *
 * - **ORGII baseline skins** — the shipped light and dark designs. They are
 *   marked `isBaseline`, which means they emit *no* token overrides: the base
 *   stylesheets stay the single source of truth, so the default look cannot
 *   drift as the derivation is tuned. Their seeds exist only so previews and
 *   the `matchSkin` accent option have something to read.
 * - **Codex skins** — generated in `codexSkins.ts`.
 *
 * A skin declares which variants it supports. Most Codex skins are dark-only,
 * so the light and dark pickers are populated independently.
 */
import { CODEX_SKINS } from "./codexSkins";
import type { SkinDefinition, SkinSeed, SkinVariant } from "./types";

export const ORGII_SKIN_ID = "orgii";

/** Mirrors the `body` scope of `public/orgii_main.css`. */
const ORGII_LIGHT_SEED: SkinSeed = {
  surface: "#ffffff",
  ink: "#1d2129",
  accent: "#1d8ffd",
  contrast: 45,
  semanticColors: {
    diffAdded: "#388a34",
    diffRemoved: "#e51400",
    skill: "#8250df",
  },
  syntax: {
    comment: "#6a737d",
    string: "#032f62",
    keyword: "#d73a49",
    function: "#6f42c1",
    variable: "#005cc5",
    number: "#005cc5",
    operator: "#005cc5",
    tag: "#116329",
    attribute: "#005cc5",
    property: "#6f42c1",
    type: "#d73a49",
    constant: "#e36209",
    invalid: "#cb2431",
  },
};

/** Mirrors the `body` scope of `public/orgii_dark.css`. */
const ORGII_DARK_SEED: SkinSeed = {
  surface: "#141414",
  ink: "#e8e8e8",
  accent: "#43aafd",
  contrast: 60,
  semanticColors: {
    diffAdded: "#89d185",
    diffRemoved: "#f14c4c",
    skill: "#a371f7",
  },
  syntax: {
    comment: "#8b949e",
    string: "#a5d6ff",
    keyword: "#ff7b72",
    function: "#d2a8ff",
    variable: "#79c0ff",
    number: "#79c0ff",
    operator: "#79c0ff",
    tag: "#7ee787",
    attribute: "#79c0ff",
    property: "#d2a8ff",
    type: "#ff7b72",
    constant: "#ffab70",
    invalid: "#f97583",
  },
};

const ORGII_SKINS: readonly SkinDefinition[] = [
  {
    id: ORGII_SKIN_ID,
    label: "ORGII",
    source: "orgii",
    isBaseline: true,
    variants: {
      light: { seed: ORGII_LIGHT_SEED },
      dark: { seed: ORGII_DARK_SEED },
    },
  },
];

/**
 * Display names ORGII shows in place of the extracted ones.
 *
 * `codexSkins.ts` is generated and records the labels Codex actually ships, so
 * it stays a faithful account of the source and a regeneration cannot quietly
 * revert an editorial choice made here. Renames therefore live in this file.
 *
 * Codex names its Claude-flavoured skin "Absolutely"; this returns the joke.
 * Only the label changes — the id is what `general.lightSkin` / `general.darkSkin`
 * persist, so renaming it would silently reset everyone who had it selected.
 */
const SKIN_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "codex-codex": "Constantly Reset",
};

function withLabelOverride(skin: SkinDefinition): SkinDefinition {
  const label = SKIN_LABEL_OVERRIDES[skin.id];
  return label ? { ...skin, label } : skin;
}

export const SKINS: readonly SkinDefinition[] = [
  ...ORGII_SKINS,
  ...CODEX_SKINS.map(withLabelOverride),
];

const SKINS_BY_ID: ReadonlyMap<string, SkinDefinition> = new Map(
  SKINS.map((skin) => [skin.id, skin])
);

export const DEFAULT_SKIN_ID: Record<SkinVariant, string> = {
  light: ORGII_SKIN_ID,
  dark: ORGII_SKIN_ID,
};

export function getSkin(
  id: string | null | undefined
): SkinDefinition | undefined {
  return id ? SKINS_BY_ID.get(id) : undefined;
}

export function skinSupportsVariant(
  skin: SkinDefinition,
  variant: SkinVariant
): boolean {
  return skin.variants[variant] != null;
}

/** Skins offering the given variant, ORGII's own first, then Codex A–Z. */
export function getSkinsForVariant(
  variant: SkinVariant
): readonly SkinDefinition[] {
  return SKINS.filter((skin) => skinSupportsVariant(skin, variant));
}

/**
 * Coerce a stored skin id to one that actually provides `variant`. Guards
 * against a dark-only skin being persisted as the light selection (possible via
 * a hand-edited settings file, or a skin losing a variant in a later release).
 */
export function resolveSkinId(
  id: string | null | undefined,
  variant: SkinVariant
): string {
  const skin = getSkin(id);
  if (skin && skinSupportsVariant(skin, variant)) return skin.id;
  return DEFAULT_SKIN_ID[variant];
}

export function getSkinSeed(
  id: string | null | undefined,
  variant: SkinVariant
): SkinSeed {
  const resolved = resolveSkinId(id, variant);
  const skin = getSkin(resolved);
  const seed = skin?.variants[variant]?.seed;
  if (seed) return seed;
  // `resolveSkinId` already fell back to a baseline id, so this is unreachable
  // unless the baseline itself is malformed.
  return variant === "light" ? ORGII_LIGHT_SEED : ORGII_DARK_SEED;
}

export function isBaselineSkin(id: string | null | undefined): boolean {
  return getSkin(id)?.isBaseline === true;
}

/**
 * Skins that can back light *and* dark, and are therefore selectable while the
 * light/dark selections are linked. Most Codex skins are dark-only upstream, so
 * this is roughly half the registry.
 */
export function getUnifiedSkins(): readonly SkinDefinition[] {
  return SKINS.filter(
    (skin) => skin.variants.light != null && skin.variants.dark != null
  );
}

export function supportsBothVariants(id: string | null | undefined): boolean {
  const skin = getSkin(id);
  return skin?.variants.light != null && skin?.variants.dark != null;
}

export const SKIN_IDS: readonly string[] = SKINS.map((skin) => skin.id);
