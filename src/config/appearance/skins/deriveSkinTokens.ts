/**
 * Turn a skin seed into the concrete CSS custom properties the app paints with.
 *
 * The base stylesheets (`orgii_main.css` / `orgii_dark.css`) stay the structural
 * source of truth: they own spacing, radii, shadows, fonts, and the warning /
 * neutral scales. A skin only overrides *color* tokens, layered on top as inline
 * custom properties. That keeps a skin ~10 values of data instead of a 170-line
 * stylesheet, and means an unrecognized token can never go missing — it simply
 * falls through to the base sheet.
 *
 * Every ratio below was calibrated against the shipped light/dark sheets, so
 * feeding ORGII's own surface/ink through this function reproduces the current
 * design closely. Baseline skins still emit nothing at all (see `registry.ts`) —
 * "closely" is not "exactly", and the default look should not drift.
 *
 * Deliberately *not* derived:
 *
 * - `--color-warning-*`. Warning is a fixed amber in both shipped sheets and
 *   carries meaning independent of the palette. A skin with no warm hue would
 *   otherwise produce a warning color indistinguishable from its accent.
 * - `--color-neutral-*`. Both sheets declare the same values; they back
 *   surfaces that are already colored, not the app chrome.
 * - Shadows, radii, blur amounts, and `--windows-native-chrome-opacity`. These
 *   are structural, not chromatic, and belong to the base stylesheet.
 * - Aliases such as `--color-chat-pane` and `--color-pane-raised`, which are
 *   declared as `var(--color-bg-2)` and therefore follow for free.
 */
import { buildRamp, formatHex, mix, parseHex, readableOn, rgba } from "./color";
import type { SkinSeed, SkinVariant } from "./types";

export type SkinTokens = Record<string, string>;

/** Fallback syntax hues, used when a skin's source theme omitted a scope. */
const SYNTAX_FALLBACK_RAMP = [
  "keyword",
  "string",
  "function",
  "variable",
  "type",
  "constant",
] as const;

/**
 * Minimum total RGB movement (summed across channels) for two surfaces to count
 * as visually separate.
 */
const MIN_SURFACE_SEPARATION = 6;

/**
 * `contrast` is 0–100 with 50 as the neutral midpoint. Higher contrast pulls
 * secondary text closer to the ink and pushes borders further from the surface.
 */
function contrastFactors(contrast: number): { text: number; edge: number } {
  const normalized = Math.min(100, Math.max(0, contrast)) / 100;
  return {
    // Multiplies "distance from ink": smaller = higher contrast text.
    text: 1.3 - normalized * 0.6,
    // Multiplies "distance from surface": larger = more visible edges.
    edge: 0.7 + normalized * 0.6,
  };
}

export function deriveSkinTokens(
  seed: SkinSeed,
  variant: SkinVariant
): SkinTokens {
  const surface = parseHex(seed.surface);
  const ink = parseHex(seed.ink);
  if (!surface || !ink) return {};

  const isLight = variant === "light";
  const { text, edge } = contrastFactors(seed.contrast);
  const black = { r: 0, g: 0, b: 0 };

  /** Mix the surface toward the ink — the "raise a surface" primitive. */
  const lift = (amount: number): string =>
    formatHex(mix(surface, ink, amount * edge));
  /** Mix the ink toward the surface — the "fade text" primitive. */
  const fade = (amount: number): string =>
    formatHex(mix(ink, surface, amount * text));
  /** Tint the surface with an arbitrary color. */
  const tint = (color: string, amount: number): string => {
    const parsed = parseHex(color);
    return parsed ? formatHex(mix(surface, parsed, amount)) : seed.surface;
  };

  const accentRamp = buildRamp(seed.accent, seed.surface, variant);
  const skillRamp = buildRamp(seed.semanticColors.skill, seed.surface, variant);
  const successRamp = buildRamp(
    seed.semanticColors.diffAdded,
    seed.surface,
    variant
  );
  const dangerRamp = buildRamp(
    seed.semanticColors.diffRemoved,
    seed.surface,
    variant
  );

  /**
   * Push a dark surface further back. OLED-black skins (Vercel Dark, Codex
   * Dark) are already at the floor, so darkening is a no-op and the recessed
   * chrome would collapse into the page. Those fall back to lifting instead:
   * at pure black the only way to render "a different surface" is upward, and
   * a visible boundary matters more than the direction of the depth cue.
   */
  const recede = (amount: number): string => {
    const receded = mix(surface, black, amount);
    const moved =
      Math.abs(receded.r - surface.r) +
      Math.abs(receded.g - surface.g) +
      Math.abs(receded.b - surface.b);
    return moved >= MIN_SURFACE_SEPARATION
      ? formatHex(receded)
      : formatHex(mix(surface, ink, amount * 0.2));
  };

  const pageSurface = seed.surface;
  const recessedSurface = isLight ? lift(0.05) : recede(0.25);
  const editorSurface = isLight ? pageSurface : recede(0.3);

  const tokens: SkinTokens = {
    // Surfaces
    "--color-bg-1": recessedSurface,
    "--color-bg-2": pageSurface,
    "--color-bg-3": isLight ? pageSurface : lift(0.1),
    "--color-bg-4": isLight ? pageSurface : lift(0.14),
    "--color-workstation-bg": isLight ? lift(0.01) : lift(0.04),
    "--color-primary-container": lift(isLight ? 0.03 : 0.05),

    // Text
    "--color-text-1": seed.ink,
    "--color-text-2": fade(isLight ? 0.25 : 0.22),
    "--color-text-3": fade(isLight ? 0.5 : 0.45),
    "--color-text-4": fade(isLight ? 0.72 : 0.65),
    "--color-text-white": isLight ? "#ffffff" : seed.ink,

    // Borders
    "--color-border-1": lift(isLight ? 0.1 : 0.12),
    "--color-border-2": lift(isLight ? 0.11 : 0.18),
    "--color-border-3": lift(isLight ? 0.22 : 0.32),

    // Fills
    "--color-fill-1": lift(isLight ? 0.04 : 0.05),
    "--color-fill-2": lift(isLight ? 0.07 : 0.07),
    "--color-fill-3": lift(isLight ? 0.12 : 0.12),
    "--color-fill-4": lift(isLight ? 0.19 : 0.18),

    // Chat surfaces
    "--color-chat-container": lift(isLight ? 0.05 : 0.06),
    "--color-chat-input": isLight ? pageSurface : lift(0.1),
    "--color-event-block": isLight ? pageSurface : lift(0.03),

    // Diff surfaces
    "--color-diff-add": tint(
      seed.semanticColors.diffAdded,
      isLight ? 0.16 : 0.3
    ),
    "--color-diff-delete": tint(
      seed.semanticColors.diffRemoved,
      isLight ? 0.16 : 0.3
    ),
    "--color-diff-collapse": tint(seed.accent, isLight ? 0.25 : 0.45),

    // Editor
    "--cm-editor-background": editorSurface,
    // Must be emitted alongside the editor background, not left to alias it.
    // The base sheets declare `--cm-editor-gutter-bg: var(--cm-editor-background)`
    // at `:root`, where it computes against `:root`'s value — skin tokens land on
    // `<body>`, so the alias would keep the stylesheet's background and paint the
    // line-number column in a different color than the code beside it.
    "--cm-editor-gutter-bg": editorSurface,
    "--cm-editor-foreground": seed.ink,
    "--cm-editor-gutter-fg": fade(isLight ? 0.5 : 0.45),
    "--cm-editor-selection": tint(seed.accent, isLight ? 0.2 : 0.45),
    "--cm-editor-line-highlight": isLight ? "transparent" : rgba(ink, 0.06),
    "--text-selection": tint(seed.accent, isLight ? 0.28 : 0.5),
    "--terminal-selection": tint(seed.accent, isLight ? 0.2 : 0.45),

    // Sidebar
    "--sidebar-bg": rgba(
      mix(surface, ink, isLight ? 0.05 : 0.03),
      isLight ? 0.78 : 0.88
    ),
    "--sidebar-border": rgba(ink, isLight ? 0.08 : 0.1),

    // Start page
    "--start-app-icon-bg": rgba(
      mix(surface, ink, isLight ? 0.0 : 0.06),
      isLight ? 0.58 : 0.68
    ),
    "--start-edit-panel-bg": rgba(
      mix(surface, ink, isLight ? 0.0 : 0.04),
      isLight ? 0.74 : 0.82
    ),
    "--start-edit-panel-border": `1px solid ${rgba(ink, isLight ? 0.08 : 0.12)}`,
  };

  const rampTargets: Array<[string, string[]]> = [
    ["--color-primary", accentRamp],
    ["--color-purple", skillRamp],
    ["--color-success", successRamp],
    ["--color-danger", dangerRamp],
  ];
  for (const [prefix, ramp] of rampTargets) {
    ramp.forEach((value, index) => {
      tokens[`${prefix}-${index + 1}`] = value;
    });
  }

  const mergedBase = parseHex(skillRamp[5]) ?? ink;
  tokens["--color-merged-button-bg"] = skillRamp[5];
  tokens["--color-merged-button-hover"] = skillRamp[6];
  tokens["--color-merged-button-active"] = isLight
    ? skillRamp[4]
    : skillRamp[6];
  tokens["--color-merged-button-contrast"] = readableOn(mergedBase);

  assignSyntaxTokens(tokens, seed, fade);

  return tokens;
}

function assignSyntaxTokens(
  tokens: SkinTokens,
  seed: SkinSeed,
  fade: (amount: number) => string
): void {
  const { syntax } = seed;
  // A skin that names no syntax color at all should not repaint code surfaces;
  // the base stylesheet's palette is better than one derived from two hues.
  if (!syntax || Object.keys(syntax).length === 0) return;

  const firstAvailable = (): string | undefined => {
    for (const key of SYNTAX_FALLBACK_RAMP) {
      const value = syntax[key];
      if (value) return value;
    }
    return undefined;
  };
  const anySyntax = firstAvailable();

  const put = (cssKey: string, value: string | undefined): void => {
    if (value) tokens[cssKey] = value;
  };

  // Real theme files rarely name all thirteen scopes, so every slot ends its
  // fallback chain at a color that is always present. A partially repainted
  // editor — some scopes from the skin, the rest from the previous theme's
  // stylesheet — would be worse than a slightly flattened palette.
  const variable = syntax.variable ?? seed.ink;

  put("--cm-syntax-comment", syntax.comment ?? fade(0.5));
  put("--cm-syntax-string", syntax.string ?? anySyntax);
  put("--cm-syntax-keyword", syntax.keyword ?? anySyntax);
  put("--cm-syntax-function", syntax.function ?? syntax.keyword ?? anySyntax);
  put("--cm-syntax-variable", variable);
  put("--cm-syntax-number", syntax.number ?? syntax.constant ?? anySyntax);
  put("--cm-syntax-operator", syntax.operator ?? syntax.keyword ?? anySyntax);
  put("--cm-syntax-tag", syntax.tag ?? syntax.keyword ?? anySyntax);
  put("--cm-syntax-attribute", syntax.attribute ?? variable);
  put("--cm-syntax-property", syntax.property ?? variable);
  put("--cm-syntax-type", syntax.type ?? syntax.keyword ?? anySyntax);
  put("--cm-syntax-constant", syntax.constant ?? syntax.number ?? anySyntax);
  put("--cm-syntax-link", syntax.string ?? anySyntax);
  put("--cm-syntax-invalid", syntax.invalid ?? seed.semanticColors.diffRemoved);
  put("--cm-syntax-deleted", seed.semanticColors.diffRemoved);
}

/** Every CSS custom property `deriveSkinTokens` can emit, for teardown. */
export const SKIN_TOKEN_KEYS: readonly string[] = (() => {
  const probe = deriveSkinTokens(
    {
      surface: "#ffffff",
      ink: "#000000",
      accent: "#3a83f7",
      contrast: 50,
      semanticColors: {
        diffAdded: "#00a240",
        diffRemoved: "#ba2623",
        skill: "#924ff7",
      },
      syntax: {
        comment: "#666666",
        string: "#008809",
        keyword: "#d53538",
        function: "#751ed9",
        variable: "#bd5800",
        number: "#0071ea",
        operator: "#666666",
        tag: "#d53538",
        attribute: "#bd5800",
        property: "#bd5800",
        type: "#751ed9",
        constant: "#0071ea",
        invalid: "#ff0000",
      },
    },
    "light"
  );
  return Object.freeze(Object.keys(probe));
})();
