import { describe, expect, it } from "vitest";

import { CODEX_SKINS } from "./codexSkins";
import {
  DEFAULT_SKIN_ID,
  ORGII_SKIN_ID,
  SKINS,
  getSkin,
  getSkinSeed,
  getSkinsForVariant,
  getUnifiedSkins,
  isBaselineSkin,
  resolveSkinId,
  supportsBothVariants,
} from "./registry";
import { SKIN_VARIANTS, type SkinVariant } from "./types";

const HEX = /^#[\da-f]{6}$/i;

describe("skin registry", () => {
  it("keeps skin ids unique", () => {
    const ids = SKINS.map((skin) => skin.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every skin at least one variant", () => {
    for (const skin of SKINS) {
      expect(Object.keys(skin.variants).length).toBeGreaterThan(0);
    }
  });

  it("ships the whole Codex theme set", () => {
    // The Codex app registry has 28 entries; a regeneration that silently
    // dropped one would otherwise go unnoticed.
    expect(CODEX_SKINS).toHaveLength(28);
  });

  it("only stores parseable colors in every seed", () => {
    for (const skin of SKINS) {
      for (const variant of SKIN_VARIANTS) {
        const definition = skin.variants[variant];
        if (!definition) continue;
        const { seed } = definition;
        const label = `${skin.id}/${variant}`;
        expect(seed.surface, label).toMatch(HEX);
        expect(seed.ink, label).toMatch(HEX);
        expect(seed.accent, label).toMatch(HEX);
        expect(seed.semanticColors.diffAdded, label).toMatch(HEX);
        expect(seed.semanticColors.diffRemoved, label).toMatch(HEX);
        expect(seed.semanticColors.skill, label).toMatch(HEX);
        for (const [scope, color] of Object.entries(seed.syntax)) {
          expect(color, `${label} syntax.${scope}`).toMatch(HEX);
        }
      }
    }
  });

  it("keeps contrast inside the 0-100 range the seed format allows", () => {
    for (const skin of SKINS) {
      for (const variant of SKIN_VARIANTS) {
        const seed = skin.variants[variant]?.seed;
        if (!seed) continue;
        expect(seed.contrast).toBeGreaterThanOrEqual(0);
        expect(seed.contrast).toBeLessThanOrEqual(100);
      }
    }
  });

  it("lists only skins that provide the requested variant", () => {
    for (const variant of SKIN_VARIANTS) {
      for (const skin of getSkinsForVariant(variant)) {
        expect(skin.variants[variant]).toBeDefined();
      }
    }
  });

  it("puts ORGII's own skins first in each variant list", () => {
    for (const variant of SKIN_VARIANTS) {
      expect(getSkinsForVariant(variant)[0]?.source).toBe("orgii");
    }
  });

  describe("label overrides", () => {
    it("renames the Codex skin without touching its persisted id", () => {
      const skin = getSkin("codex-codex");
      expect(skin?.label).toBe("Constantly Reset");
      // The id is what settings persist. Renaming it would reset every install
      // that had this skin selected, because the settings enum would no longer
      // accept the stored value.
      expect(skin?.id).toBe("codex-codex");
    });

    it("leaves the generated data itself untouched", () => {
      // The generated module stays a faithful record of what Codex ships, so a
      // regeneration cannot revert the rename.
      const generated = CODEX_SKINS.find((s) => s.id === "codex-codex");
      expect(generated?.label).toBe("Codex");
    });

    it("keeps every other skin on its extracted label", () => {
      for (const generated of CODEX_SKINS) {
        if (generated.id === "codex-codex") continue;
        expect(getSkin(generated.id)?.label, generated.id).toBe(
          generated.label
        );
      }
    });
  });

  it("treats only the ORGII skin as baseline", () => {
    expect(isBaselineSkin(ORGII_SKIN_ID)).toBe(true);
    expect(isBaselineSkin("codex-dracula")).toBe(false);
  });

  it("gives the ORGII baseline both variants so it can be linked", () => {
    expect(supportsBothVariants(ORGII_SKIN_ID)).toBe(true);
    expect(getUnifiedSkins().map((skin) => skin.id)).toContain(ORGII_SKIN_ID);
  });

  it("only offers dual-variant skins while light and dark are linked", () => {
    for (const skin of getUnifiedSkins()) {
      expect(skin.variants.light, skin.id).toBeDefined();
      expect(skin.variants.dark, skin.id).toBeDefined();
    }
    // Dracula is dark-only upstream and must not be linkable.
    expect(supportsBothVariants("codex-dracula")).toBe(false);
  });

  describe("resolveSkinId", () => {
    it("keeps a skin that supports the variant", () => {
      expect(resolveSkinId("codex-github", "light")).toBe("codex-github");
      expect(resolveSkinId("codex-github", "dark")).toBe("codex-github");
    });

    it("falls back when the skin has no such variant", () => {
      // Dracula is dark-only upstream, so it can never back light mode.
      expect(getSkin("codex-dracula")?.variants.light).toBeUndefined();
      expect(resolveSkinId("codex-dracula", "light")).toBe(
        DEFAULT_SKIN_ID.light
      );
    });

    it("falls back for unknown and empty ids", () => {
      for (const variant of SKIN_VARIANTS) {
        expect(resolveSkinId("nope", variant)).toBe(DEFAULT_SKIN_ID[variant]);
        expect(resolveSkinId(null, variant)).toBe(DEFAULT_SKIN_ID[variant]);
        expect(resolveSkinId(undefined, variant)).toBe(
          DEFAULT_SKIN_ID[variant]
        );
      }
    });
  });

  it("returns a usable seed even for an unresolvable id", () => {
    for (const variant of SKIN_VARIANTS) {
      expect(getSkinSeed("nope", variant).surface).toMatch(HEX);
    }
  });

  it("keeps each variant's baseline on the expected side of mid-grey", () => {
    const brightness = (hex: string): number => {
      const value = hex.slice(1);
      return (
        (Number.parseInt(value.slice(0, 2), 16) +
          Number.parseInt(value.slice(2, 4), 16) +
          Number.parseInt(value.slice(4, 6), 16)) /
        3
      );
    };
    const check = (variant: SkinVariant): void => {
      const seed = getSkinSeed(DEFAULT_SKIN_ID[variant], variant);
      if (variant === "light") {
        expect(brightness(seed.surface)).toBeGreaterThan(brightness(seed.ink));
      } else {
        expect(brightness(seed.surface)).toBeLessThan(brightness(seed.ink));
      }
    };
    SKIN_VARIANTS.forEach(check);
  });
});
