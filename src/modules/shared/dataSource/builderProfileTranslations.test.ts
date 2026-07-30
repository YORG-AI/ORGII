import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface BuilderProfileMessages {
  types: {
    withAgents?: string;
    letters: Record<
      string,
      {
        description: string;
        agentTip: string;
      }
    >;
  };
}

const localesRoot = resolve(process.cwd(), "src/i18n/locales");
const localeFiles = readdirSync(localesRoot).map((locale) =>
  resolve(localesRoot, locale, "builderProfile.json")
);

describe("builder profile translations", () => {
  it("keeps every locale valid UTF-8 without replacement characters", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });

    for (const file of localeFiles) {
      const text = decoder.decode(readFileSync(file));
      expect(text).not.toContain("\uFFFD");
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("uses one punctuation-free bullet pair per preference", () => {
    for (const file of localeFiles) {
      const messages = JSON.parse(
        readFileSync(file, "utf8")
      ) as BuilderProfileMessages;

      expect(messages.types.withAgents).toBeUndefined();
      for (const letter of Object.values(messages.types.letters)) {
        expect(letter.description).not.toMatch(/[.。]\s*$/);
        expect(letter.agentTip).not.toMatch(/[.。]\s*$/);
      }
    }
  });
});
