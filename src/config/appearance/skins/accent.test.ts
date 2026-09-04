import { describe, expect, it } from "vitest";

import { PRIMARY_COLOR_PRESETS } from "@src/config/appearance/primaryColors";

import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_PRESET,
  MATCH_SKIN_ACCENT,
  buildSkinAccentPalette,
  getAccentSwatch,
  isAccentPreset,
  normalizeAccentPreset,
  resolveAccentPalette,
} from "./accent";
import { getSkinSeed } from "./registry";
import { SKIN_VARIANTS } from "./types";

const SEED = getSkinSeed("codex-dracula", "dark");

describe("accent presets", () => {
  it("offers matchSkin plus every named preset", () => {
    expect(ACCENT_PRESETS).toEqual([
      MATCH_SKIN_ACCENT,
      ...PRIMARY_COLOR_PRESETS,
    ]);
  });

  it("defaults to matchSkin so a skin's own accent survives", () => {
    expect(DEFAULT_ACCENT_PRESET).toBe(MATCH_SKIN_ACCENT);
  });

  it("recognizes only real presets", () => {
    expect(isAccentPreset("violet")).toBe(true);
    expect(isAccentPreset(MATCH_SKIN_ACCENT)).toBe(true);
    expect(isAccentPreset("chartreuse")).toBe(false);
    expect(isAccentPreset(undefined)).toBe(false);
  });

  it("normalizes anything unrecognized back to the default", () => {
    expect(normalizeAccentPreset("teal")).toBe("teal");
    expect(normalizeAccentPreset("chartreuse")).toBe(DEFAULT_ACCENT_PRESET);
    expect(normalizeAccentPreset(null)).toBe(DEFAULT_ACCENT_PRESET);
  });

  describe("resolveAccentPalette", () => {
    it("returns null for matchSkin so the skin keeps its ramp", () => {
      for (const variant of SKIN_VARIANTS) {
        expect(resolveAccentPalette(MATCH_SKIN_ACCENT, variant)).toBeNull();
      }
    });

    it("returns a full 7-stop ramp for every named preset", () => {
      for (const preset of PRIMARY_COLOR_PRESETS) {
        for (const variant of SKIN_VARIANTS) {
          const palette = resolveAccentPalette(preset, variant);
          expect(palette, `${preset}/${variant}`).not.toBeNull();
          expect(Object.keys(palette ?? {})).toHaveLength(7);
        }
      }
    });

    it("resolves blue rather than treating it as a no-op", () => {
      // Blue used to mean "emit nothing". A skin can now repaint the ramp, so
      // picking blue has to actively override it.
      expect(resolveAccentPalette("blue", "dark")).not.toBeNull();
    });
  });

  describe("getAccentSwatch", () => {
    it("previews the skin's accent for matchSkin", () => {
      expect(getAccentSwatch(MATCH_SKIN_ACCENT, "dark", SEED)).toBe(
        SEED.accent
      );
    });

    it("previews the preset's mid stop otherwise", () => {
      expect(getAccentSwatch("violet", "dark", SEED)).toMatch(/^#[\da-f]{6}$/i);
      expect(getAccentSwatch("violet", "dark", SEED)).not.toBe(SEED.accent);
    });
  });

  it("builds a skin ramp whose mid stop is the skin accent", () => {
    const palette = buildSkinAccentPalette(SEED, "dark");
    expect(palette["--color-primary-6"]).toBe(SEED.accent);
    expect(Object.keys(palette)).toHaveLength(7);
  });
});
