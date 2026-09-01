// @vitest-environment jsdom
/**
 * Pins the coordination between the base stylesheet and the active skin.
 *
 * A variant flip changes two things: which stylesheet is attached, and which
 * skin tokens override it. React learns about the second one a tick after the
 * first, so `syncThemeAppearance` applies the skin itself, at promotion time.
 * Two bugs live here if it does not:
 *
 * - the new stylesheet paints under the *previous* variant's skin for a frame,
 *   which is exactly what an OS-driven light/dark flip shows the user;
 * - reading the variant back off the computed `--color-bg-2` (as the old
 *   implementation did) sees those stale tokens and picks the wrong variant,
 *   which then re-applies the wrong skin.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSkinSeed } from "@src/config/appearance/skins/registry";

import {
  SKIN_SELECTION_STORAGE_KEY,
  applySkinTokensForVariant,
  clearSkinTokens,
  writeSkinSelection,
} from "../applySkinTokens";
import { syncThemeAppearance } from "../swapThemeCss";

const LIGHT_CSS = "/orgii_main.css";
const DARK_CSS = "/orgii_dark.css";

function bodyToken(name: string): string {
  return document.body.style.getPropertyValue(name);
}

beforeEach(() => {
  localStorage.clear();
  clearSkinTokens();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-skin");
});

afterEach(() => {
  clearSkinTokens();
  localStorage.clear();
});

describe("applySkinTokensForVariant", () => {
  it("does nothing before a selection has been mirrored", () => {
    applySkinTokensForVariant("dark");
    expect(bodyToken("--color-bg-2")).toBe("");
  });

  it("paints the mirrored skin for the requested variant", () => {
    writeSkinSelection({
      light: { skinId: "codex-github", accent: "matchSkin" },
      dark: { skinId: "codex-dracula", accent: "matchSkin" },
    });

    applySkinTokensForVariant("dark");
    expect(bodyToken("--color-bg-2")).toBe(
      getSkinSeed("codex-dracula", "dark").surface
    );

    applySkinTokensForVariant("light");
    expect(bodyToken("--color-bg-2")).toBe(
      getSkinSeed("codex-github", "light").surface
    );
  });

  it("clears the previous skin's tokens rather than merging them", () => {
    writeSkinSelection({
      light: { skinId: "orgii", accent: "matchSkin" },
      dark: { skinId: "codex-dracula", accent: "matchSkin" },
    });

    applySkinTokensForVariant("dark");
    expect(bodyToken("--color-bg-2")).not.toBe("");

    // ORGII is a baseline skin: it emits nothing, so the dark skin's tokens
    // must be removed rather than left behind under the light stylesheet.
    applySkinTokensForVariant("light");
    expect(bodyToken("--color-bg-2")).toBe("");
  });

  it("ignores a malformed mirror instead of throwing", () => {
    localStorage.setItem(SKIN_SELECTION_STORAGE_KEY, "{not json");
    expect(() => applySkinTokensForVariant("dark")).not.toThrow();
    expect(bodyToken("--color-bg-2")).toBe("");
  });

  it("falls back when the mirrored skin cannot serve the variant", () => {
    // Dracula is dark-only; mirrored as the light selection it must not paint
    // a dark surface under the light stylesheet.
    writeSkinSelection({
      light: { skinId: "codex-dracula", accent: "matchSkin" },
      dark: { skinId: "codex-dracula", accent: "matchSkin" },
    });
    applySkinTokensForVariant("light");
    expect(bodyToken("--color-bg-2")).toBe("");
  });
});

describe("syncThemeAppearance", () => {
  it("derives the variant from the stylesheet, not from stale tokens", () => {
    writeSkinSelection({
      light: { skinId: "codex-github", accent: "matchSkin" },
      dark: { skinId: "codex-dracula", accent: "matchSkin" },
    });

    syncThemeAppearance(DARK_CSS);
    expect(document.documentElement.dataset.theme).toBe("dark");

    // Body now carries Dracula's dark surface. Swapping to the light sheet must
    // still resolve as light — the old computed-style probe did not.
    syncThemeAppearance(LIGHT_CSS);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(bodyToken("--color-bg-2")).toBe(
      getSkinSeed("codex-github", "light").surface
    );
  });

  it("swaps the skin in the same call that swaps the stylesheet", () => {
    writeSkinSelection({
      light: { skinId: "codex-github", accent: "matchSkin" },
      dark: { skinId: "codex-dracula", accent: "matchSkin" },
    });

    syncThemeAppearance(LIGHT_CSS);
    const light = bodyToken("--color-bg-2");
    syncThemeAppearance(DARK_CSS);
    const dark = bodyToken("--color-bg-2");

    expect(light).toBe(getSkinSeed("codex-github", "light").surface);
    expect(dark).toBe(getSkinSeed("codex-dracula", "dark").surface);
    expect(light).not.toBe(dark);
    expect(document.documentElement.dataset.skin).toBe("codex-dracula");
  });
});
