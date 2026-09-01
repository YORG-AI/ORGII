import { describe, expect, it } from "vitest";

import { parseHex, relativeLuminance } from "./color";
import { SKIN_TOKEN_KEYS, deriveSkinTokens } from "./deriveSkinTokens";
import { SKINS } from "./registry";
import { SKIN_VARIANTS, type SkinSeed, type SkinVariant } from "./types";

const DARK_SEED: SkinSeed = {
  surface: "#282a36",
  ink: "#f8f8f2",
  accent: "#ff79c6",
  contrast: 60,
  semanticColors: {
    diffAdded: "#50fa7b",
    diffRemoved: "#ff5555",
    skill: "#bd93f9",
  },
  syntax: { comment: "#6272a4", keyword: "#ff79c6", string: "#f1fa8c" },
};

const LIGHT_SEED: SkinSeed = {
  surface: "#ffffff",
  ink: "#1f2328",
  accent: "#0969da",
  contrast: 45,
  semanticColors: {
    diffAdded: "#1a7f37",
    diffRemoved: "#cf222e",
    skill: "#8250df",
  },
  syntax: { comment: "#6e7781", keyword: "#cf222e", string: "#0a3069" },
};

function luminanceOf(value: string): number {
  const color = parseHex(value);
  if (!color) throw new Error(`not a hex color: ${value}`);
  return relativeLuminance(color);
}

describe("deriveSkinTokens", () => {
  it("anchors the page surface on the seed's own surface", () => {
    expect(deriveSkinTokens(DARK_SEED, "dark")["--color-bg-2"]).toBe(
      DARK_SEED.surface
    );
    expect(deriveSkinTokens(LIGHT_SEED, "light")["--color-bg-2"]).toBe(
      LIGHT_SEED.surface
    );
  });

  it("uses the seed ink as primary text", () => {
    expect(deriveSkinTokens(DARK_SEED, "dark")["--color-text-1"]).toBe(
      DARK_SEED.ink
    );
  });

  it("fades the text ramp monotonically toward the surface", () => {
    const tokens = deriveSkinTokens(DARK_SEED, "dark");
    const ramp = [
      luminanceOf(tokens["--color-text-1"]),
      luminanceOf(tokens["--color-text-2"]),
      luminanceOf(tokens["--color-text-3"]),
      luminanceOf(tokens["--color-text-4"]),
    ];
    // Dark surface, light ink: each step must move toward the darker surface.
    for (let index = 1; index < ramp.length; index += 1) {
      expect(ramp[index]).toBeLessThan(ramp[index - 1]);
    }
  });

  it("raises fills and borders progressively away from the surface", () => {
    const tokens = deriveSkinTokens(LIGHT_SEED, "light");
    const fills = [1, 2, 3, 4].map((step) =>
      luminanceOf(tokens[`--color-fill-${step}`])
    );
    for (let index = 1; index < fills.length; index += 1) {
      expect(fills[index]).toBeLessThan(fills[index - 1]);
    }
    const borders = [1, 2, 3].map((step) =>
      luminanceOf(tokens[`--color-border-${step}`])
    );
    expect(borders[2]).toBeLessThan(borders[0]);
  });

  it("pulls secondary text closer to the ink as contrast rises", () => {
    const low = deriveSkinTokens({ ...DARK_SEED, contrast: 0 }, "dark");
    const high = deriveSkinTokens({ ...DARK_SEED, contrast: 100 }, "dark");
    const inkLuminance = luminanceOf(DARK_SEED.ink);
    const distance = (value: string): number =>
      Math.abs(luminanceOf(value) - inkLuminance);
    expect(distance(high["--color-text-2"])).toBeLessThan(
      distance(low["--color-text-2"])
    );
  });

  it("pushes borders further from the surface as contrast rises", () => {
    const low = deriveSkinTokens({ ...LIGHT_SEED, contrast: 0 }, "light");
    const high = deriveSkinTokens({ ...LIGHT_SEED, contrast: 100 }, "light");
    const surfaceLuminance = luminanceOf(LIGHT_SEED.surface);
    const distance = (value: string): number =>
      Math.abs(luminanceOf(value) - surfaceLuminance);
    expect(distance(high["--color-border-3"])).toBeGreaterThan(
      distance(low["--color-border-3"])
    );
  });

  it("anchors --color-primary-6 on the seed accent in both variants", () => {
    // The design system treats stop 6 as "the accent" — the carets alias it.
    expect(deriveSkinTokens(LIGHT_SEED, "light")["--color-primary-6"]).toBe(
      LIGHT_SEED.accent
    );
    expect(deriveSkinTokens(DARK_SEED, "dark")["--color-primary-6"]).toBe(
      DARK_SEED.accent
    );
    for (const step of [1, 2, 3, 4, 5, 6, 7]) {
      expect(
        deriveSkinTokens(DARK_SEED, "dark")[`--color-primary-${step}`]
      ).toMatch(/^#[\da-f]{6}$/i);
    }
  });

  it("maps the semantic hues onto their own ramps", () => {
    const tokens = deriveSkinTokens(LIGHT_SEED, "light");
    expect(tokens["--color-success-6"]).toBe(
      LIGHT_SEED.semanticColors.diffAdded
    );
    expect(tokens["--color-danger-6"]).toBe(
      LIGHT_SEED.semanticColors.diffRemoved
    );
    expect(tokens["--color-purple-6"]).toBe(LIGHT_SEED.semanticColors.skill);
  });

  it("picks a merged-button label that is readable on its own fill", () => {
    const tokens = deriveSkinTokens(LIGHT_SEED, "light");
    expect(["#ffffff", "#000000"]).toContain(
      tokens["--color-merged-button-contrast"]
    );
  });

  it("leaves code surfaces alone when a skin names no syntax color", () => {
    const tokens = deriveSkinTokens({ ...DARK_SEED, syntax: {} }, "dark");
    const syntaxKeys = Object.keys(tokens).filter((key) =>
      key.startsWith("--cm-syntax-")
    );
    expect(syntaxKeys).toEqual([]);
  });

  it("fills every syntax slot once any syntax color is present", () => {
    const tokens = deriveSkinTokens(DARK_SEED, "dark");
    for (const scope of [
      "comment",
      "string",
      "keyword",
      "function",
      "variable",
      "number",
      "operator",
      "tag",
      "attribute",
      "property",
      "type",
      "constant",
      "link",
      "invalid",
    ]) {
      expect(tokens[`--cm-syntax-${scope}`]).toBeDefined();
    }
  });

  it("keeps recessed chrome separable on an OLED-black surface", () => {
    // Pure black cannot be darkened, so the recessed surface and the editor
    // must still land somewhere other than the page surface.
    const oled: SkinSeed = { ...DARK_SEED, surface: "#000000" };
    const tokens = deriveSkinTokens(oled, "dark");
    expect(tokens["--color-bg-2"]).toBe("#000000");
    expect(tokens["--color-bg-1"]).not.toBe("#000000");
    expect(tokens["--cm-editor-background"]).not.toBe("#000000");
  });

  it("still recedes a dark surface that has room below it", () => {
    const tokens = deriveSkinTokens(DARK_SEED, "dark");
    expect(luminanceOf(tokens["--color-bg-1"])).toBeLessThan(
      luminanceOf(tokens["--color-bg-2"])
    );
  });

  it("returns nothing for a seed whose colors cannot be parsed", () => {
    expect(
      deriveSkinTokens({ ...DARK_SEED, surface: "rebeccapurple" }, "dark")
    ).toEqual({});
  });

  it("emits only keys covered by the teardown list", () => {
    const covered = new Set(SKIN_TOKEN_KEYS);
    for (const skin of SKINS) {
      for (const variant of SKIN_VARIANTS) {
        const seed = skin.variants[variant]?.seed;
        if (!seed) continue;
        for (const key of Object.keys(deriveSkinTokens(seed, variant))) {
          expect(covered.has(key), `${skin.id}/${variant}: ${key}`).toBe(true);
        }
      }
    }
  });

  it("keeps primary text legible against the surface for every shipped skin", () => {
    const contrast = (a: string, b: string): number => {
      const first = luminanceOf(a);
      const second = luminanceOf(b);
      const lighter = Math.max(first, second);
      const darker = Math.min(first, second);
      return (lighter + 0.05) / (darker + 0.05);
    };
    const check = (variant: SkinVariant): void => {
      for (const skin of SKINS) {
        const seed = skin.variants[variant]?.seed;
        if (!seed) continue;
        // WCAG AA for large text. Several upstream themes sit just under the
        // 4.5 body-text bar by design, so this guards against a seed that is
        // outright unreadable rather than asserting full AA compliance.
        expect(
          contrast(seed.ink, seed.surface),
          `${skin.id}/${variant}`
        ).toBeGreaterThan(3);
      }
    };
    SKIN_VARIANTS.forEach(check);
  });
});
