import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const profileKeys = [
  "techSavvy",
  "techSavvyDescription",
  "jobRoles",
  "jobRolesDescription",
  "familiarTechStacks",
  "familiarTechStacksDescription",
  "description",
  "descriptionHelp",
] as const;

interface SettingsMessages {
  myRoles: {
    profile: Record<(typeof profileKeys)[number], string>;
  };
}

const localesRoot = resolve(process.cwd(), "src/i18n/locales");
const localeFiles = readdirSync(localesRoot).map((locale) =>
  resolve(localesRoot, locale, "settings.json")
);

describe("My Roles profile translations", () => {
  it("localizes every visible single-profile control in every locale", () => {
    for (const file of localeFiles) {
      const messages = JSON.parse(
        readFileSync(file, "utf8")
      ) as SettingsMessages;

      for (const key of profileKeys) {
        const value = messages.myRoles.profile[key];
        expect(value, `${file}: ${key}`).toBeTypeOf("string");
        expect(value.trim(), `${file}: ${key}`).not.toBe("");
        expect(value, `${file}: ${key}`).not.toBe(`myRoles.profile.${key}`);
      }
    }
  });
});
