import { describe, expect, it } from "vitest";

import { PRIMARY_COLOR_PALETTES } from "@src/config/appearance/primaryColors";

import { MATCH_SKIN_ACCENT } from "./accent";
import { resolveAppliedSkinTokens } from "./appliedTokens";
import { SKIN_TOKEN_KEYS } from "./deriveSkinTokens";
import { ORGII_SKIN_ID, getSkinSeed } from "./registry";

describe("resolveAppliedSkinTokens", () => {
  describe("baseline skins", () => {
    it("emits nothing so the shipped stylesheet stays authoritative", () => {
      expect(
        resolveAppliedSkinTokens(ORGII_SKIN_ID, "light", MATCH_SKIN_ACCENT)
      ).toEqual({});
      expect(
        resolveAppliedSkinTokens(ORGII_SKIN_ID, "dark", MATCH_SKIN_ACCENT)
      ).toEqual({});
    });

    it("emits only the accent ramp when a named preset is chosen", () => {
      const tokens = resolveAppliedSkinTokens(ORGII_SKIN_ID, "light", "violet");
      expect(Object.keys(tokens).sort()).toEqual(
        Object.keys(PRIMARY_COLOR_PALETTES.violet.light).sort()
      );
      expect(tokens["--color-primary-6"]).toBe(
        PRIMARY_COLOR_PALETTES.violet.light["--color-primary-6"]
      );
    });
  });

  describe("codex skins", () => {
    it("repaints surfaces and keeps the skin's own accent under matchSkin", () => {
      const seed = getSkinSeed("codex-dracula", "dark");
      const tokens = resolveAppliedSkinTokens(
        "codex-dracula",
        "dark",
        MATCH_SKIN_ACCENT
      );
      expect(tokens["--color-bg-2"]).toBe(seed.surface);
      expect(tokens["--color-text-1"]).toBe(seed.ink);
      expect(tokens["--color-primary-6"]).toBe(seed.accent);
    });

    it("lets a named accent preset override the skin's accent", () => {
      const seed = getSkinSeed("codex-dracula", "dark");
      const tokens = resolveAppliedSkinTokens("codex-dracula", "dark", "teal");
      // Surfaces still come from the skin...
      expect(tokens["--color-bg-2"]).toBe(seed.surface);
      // ...but the ramp is the preset's, not the skin's.
      expect(tokens["--color-primary-6"]).toBe(
        PRIMARY_COLOR_PALETTES.teal.dark["--color-primary-6"]
      );
      expect(tokens["--color-primary-6"]).not.toBe(seed.accent);
    });

    it("coerces a skin that cannot serve the requested variant", () => {
      // Dracula is dark-only, so asking for light must fall back to the
      // baseline rather than painting a dark surface in light mode.
      expect(
        resolveAppliedSkinTokens("codex-dracula", "light", MATCH_SKIN_ACCENT)
      ).toEqual({});
    });
  });

  it("never emits a key outside the teardown list", () => {
    const covered = new Set(SKIN_TOKEN_KEYS);
    for (const preset of [MATCH_SKIN_ACCENT, "violet", "mono"] as const) {
      for (const key of Object.keys(
        resolveAppliedSkinTokens("codex-github", "light", preset)
      )) {
        expect(covered.has(key), key).toBe(true);
      }
    }
  });
});
