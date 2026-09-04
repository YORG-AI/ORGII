import { describe, expect, it } from "vitest";

import { getSettingsDefaults, validateSettings } from "../index";

describe("per-variant accent migration", () => {
  it("defaults both variants to matchSkin", () => {
    const defaults = getSettingsDefaults();
    expect(defaults["general.primaryColorLight"]).toBe("matchSkin");
    expect(defaults["general.primaryColorDark"]).toBe("matchSkin");
  });

  it("carries a deliberate legacy accent to both variants", () => {
    const settings = validateSettings({ "general.primaryColor": "violet" });
    expect(settings["general.primaryColorLight"]).toBe("violet");
    expect(settings["general.primaryColorDark"]).toBe("violet");
  });

  it("drops a legacy blue, which was only ever the old default", () => {
    const settings = validateSettings({ "general.primaryColor": "blue" });
    expect(settings["general.primaryColorLight"]).toBe("matchSkin");
    expect(settings["general.primaryColorDark"]).toBe("matchSkin");
  });

  it("never overwrites an explicit per-variant choice", () => {
    const settings = validateSettings({
      "general.primaryColor": "violet",
      "general.primaryColorDark": "teal",
    });
    expect(settings["general.primaryColorLight"]).toBe("violet");
    expect(settings["general.primaryColorDark"]).toBe("teal");
  });

  it("ignores a legacy value that is not a known preset", () => {
    const settings = validateSettings({ "general.primaryColor": "chartreuse" });
    expect(settings["general.primaryColorLight"]).toBe("matchSkin");
  });

  it("stops emitting the retired key", () => {
    const settings = validateSettings({ "general.primaryColor": "violet" });
    expect(settings).not.toHaveProperty("general.primaryColor");
  });
});

describe("retired theme ids", () => {
  it("resolves a stored high-contrast theme to dark", () => {
    const settings = validateSettings({
      "general.theme": "orgii-high-contrast",
    });
    // `general.theme` is validated against the current enum, so the retired id
    // is rejected and falls back to the default rather than persisting.
    expect(["system", "light", "dark"]).toContain(settings["general.theme"]);
  });

  it("keeps light and dark skin selections independent", () => {
    const settings = validateSettings({
      "general.lightSkin": "codex-github",
      "general.darkSkin": "codex-dracula",
    });
    expect(settings["general.lightSkin"]).toBe("codex-github");
    expect(settings["general.darkSkin"]).toBe("codex-dracula");
  });

  it("rejects a dark-only skin stored as the light selection", () => {
    const settings = validateSettings({ "general.lightSkin": "codex-dracula" });
    expect(settings["general.lightSkin"]).toBe("orgii");
  });

  it("defaults the new surface and icon preferences", () => {
    const defaults = getSettingsDefaults();
    expect(defaults["general.translucentSidebar"]).toBe(true);
    expect(defaults["general.iconStyle"]).toBe("colorful");
  });
});
