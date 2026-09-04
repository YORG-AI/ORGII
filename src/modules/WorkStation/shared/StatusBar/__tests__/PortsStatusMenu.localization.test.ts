import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface CommonMessages {
  workstation: {
    ports: {
      workspaceSection: string;
    };
  };
}

const localesDirectory = resolve(process.cwd(), "src/i18n/locales");
const localeNames = readdirSync(localesDirectory, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

function readCommonMessages(locale: string): CommonMessages {
  return JSON.parse(
    readFileSync(resolve(localesDirectory, locale, "common.json"), "utf8")
  ) as CommonMessages;
}

describe("PortsStatusMenu localization", () => {
  it.each(localeNames)(
    "localizes the current-workspace section in %s",
    (locale) => {
      const label =
        readCommonMessages(locale).workstation.ports.workspaceSection;

      expect(label.trim()).not.toBe("");
      if (locale !== "en") expect(label).not.toMatch(/workspace/i);
    }
  );

  it("uses concise native wording in both Chinese catalogs", () => {
    expect(readCommonMessages("zh").workstation.ports.workspaceSection).toBe(
      "当前工作区"
    );
    expect(
      readCommonMessages("zh-Hant").workstation.ports.workspaceSection
    ).toBe("目前工作區");
  });
});
