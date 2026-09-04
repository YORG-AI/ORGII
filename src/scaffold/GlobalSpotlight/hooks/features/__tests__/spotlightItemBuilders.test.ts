import { describe, expect, it, vi } from "vitest";

import {
  APPEARANCE_MODE,
  type GlobalThemePreference,
} from "@src/config/appearance/globalThemes";
import { LANGUAGE_PREFERENCE } from "@src/i18n";

import { ACTIONS } from "../../../config";
import {
  type Translator,
  buildActionItems,
  buildLanguageItems,
  buildSkinItems,
  buildThemeItems,
} from "../spotlightItemBuilders";

const translations: Record<string, string> = {
  "settings:general.followSystem": "Follow system",
  "settings:general.languageNames.en": "英语",
  "settings:general.languageNames.fr": "法语",
  "settings:general.light": "Light",
  "settings:general.dark": "Dark",
  "settings:general.skinGroups.orgii": "ORGII",
  "settings:general.skinGroups.codex": "Codex",
  "common:spotlightActions.changeTheme": "Change theme",
  "common:spotlightActions.changeSkin": "Change skin",
};

const translate: Translator = (key) => translations[key] ?? key;

describe("Spotlight settings item builders", () => {
  it("shows Follow system with a native-language suffix", () => {
    const items = buildLanguageItems(
      LANGUAGE_PREFERENCE.SYSTEM,
      "",
      vi.fn(),
      translate
    );

    expect(items.find((item) => item.id === "language-system")).toMatchObject({
      label: "Follow system · English",
    });
  });

  it("keeps the translated and native names on the English option", () => {
    const items = buildLanguageItems(
      LANGUAGE_PREFERENCE.SYSTEM,
      "英语",
      vi.fn(),
      translate
    );

    expect(items).toMatchObject([
      { id: "language-en", label: "英语 · English" },
    ]);
  });

  it("keeps bilingual labels for non-English languages", () => {
    const items = buildLanguageItems(
      LANGUAGE_PREFERENCE.SYSTEM,
      "法语",
      vi.fn(),
      translate
    );

    expect(items).toMatchObject([
      {
        id: "language-fr",
        label: "法语 · Français",
      },
    ]);
  });

  it("exposes Change theme and Change skin as second-level actions", () => {
    expect(
      ACTIONS.filter((action) =>
        ["change-theme", "change-skin"].includes(action.id)
      ).map((action) => ({ id: action.id, params: action.requiredParams }))
    ).toEqual([
      { id: "change-theme", params: ["theme"] },
      { id: "change-skin", params: ["skin"] },
    ]);

    expect(
      buildActionItems(vi.fn(), translate)
        .filter((item) => ["change-theme", "change-skin"].includes(item.id))
        .map((item) => ({ label: item.label, data: item.data }))
    ).toEqual([
      {
        label: "Change theme",
        data: { showDisclosureChevron: true },
      },
      {
        label: "Change skin",
        data: { showDisclosureChevron: true },
      },
    ]);
  });

  it("offers the same system, light, and dark modes as Settings", () => {
    const onSelectTheme = vi.fn<(theme: GlobalThemePreference) => void>();
    const items = buildThemeItems(
      APPEARANCE_MODE.DARK,
      APPEARANCE_MODE.LIGHT,
      "",
      onSelectTheme,
      translate
    );

    expect(items.map((item) => item.label)).toEqual([
      "Follow system (Light)",
      "Light",
      "Dark",
    ]);
    expect(items.find((item) => item.id === "theme-dark")?.data).toMatchObject({
      isCurrentSelection: true,
    });

    items.find((item) => item.id === "theme-light")?.action?.();
    expect(onSelectTheme).toHaveBeenCalledWith(APPEARANCE_MODE.LIGHT);
  });

  it("filters skins to the live variant and preserves source grouping", () => {
    const onSelectSkin = vi.fn();
    const lightItems = buildSkinItems(
      "orgii",
      "light",
      "dracula",
      onSelectSkin,
      translate
    );
    expect(lightItems).toEqual([]);

    const darkItems = buildSkinItems(
      "codex-dracula",
      "dark",
      "dracula",
      onSelectSkin,
      translate
    );
    expect(darkItems).toMatchObject([
      {
        id: "skin-group-codex",
        label: "Codex",
        data: { isHeader: true },
      },
      {
        id: "skin-codex-dracula",
        label: "Dracula",
        data: { isCurrentSelection: true },
      },
    ]);

    darkItems[1]?.action?.();
    expect(onSelectSkin).toHaveBeenCalledWith("codex-dracula", "dark");
  });
});
