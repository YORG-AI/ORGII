import { describe, expect, it } from "vitest";

import zhCommon from "@src/i18n/locales/zh/common.json";
import zhSettings from "@src/i18n/locales/zh/settings.json";

import { buildSettingsNavigationGroups } from "./settingsNavigation";
import { getSettingsKeys } from "./settingsSchema";
import { buildGlobalSettingsSearchGroups } from "./settingsSearch";

const NAMESPACES: Record<string, unknown> = {
  common: zhCommon,
  settings: zhSettings,
};

function translate(key: string): string {
  const [namespace, nestedKey] = key.includes(":")
    ? key.split(":", 2)
    : ["settings", key];
  const value = nestedKey
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[part]
          : undefined,
      NAMESPACES[namespace]
    );
  return typeof value === "string" ? value : key;
}

describe("global settings search catalog", () => {
  it("automatically indexes every schema-backed setting exactly once", () => {
    const navigationGroups = buildSettingsNavigationGroups(translate, true);
    const items = buildGlobalSettingsSearchGroups(
      translate,
      navigationGroups
    ).flatMap((group) => group.items);

    expect(items.map((item) => item.key).sort()).toEqual(
      getSettingsKeys().sort()
    );
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("localizes global results and sends appearance controls to their tab", () => {
    const navigationGroups = buildSettingsNavigationGroups(translate, true);
    const items = buildGlobalSettingsSearchGroups(
      translate,
      navigationGroups
    ).flatMap((group) => group.items);

    expect(
      items.find((item) => item.key === "general.primaryColorLight")
    ).toMatchObject({
      label: "浅色强调色",
      path: "/orgii/app/settings/app/appearance/app",
      searchTerms: expect.arrayContaining(["强调色"]),
    });
    expect(items.find((item) => item.key === "editor.fontSize")).toMatchObject({
      label: "字体大小",
      path: "/orgii/app/settings/app/appearance/code-editor",
    });
  });
});
