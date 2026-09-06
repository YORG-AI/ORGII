import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const locales = resolve(process.cwd(), "src/i18n/locales");
const keys = ["refreshedDelta", "refreshedNoChange", "refreshPartial"];
const placeholders = (value: string) => value.match(/{{\w+}}/g)?.sort() ?? [];
const read = (locale: string, namespace: string) =>
  JSON.parse(
    readFileSync(resolve(locales, locale, `${namespace}.json`), "utf8")
  );

describe("notification translation catalogs", () => {
  it.each(readdirSync(locales))(
    "provides refresh and task messages in %s",
    (locale) => {
      const toasts = read(locale, "integrations").keyVault.toasts;
      const source = read("en", "integrations").keyVault.toasts;
      for (const key of keys) {
        expect(toasts[key]).toBeTruthy();
        expect(placeholders(toasts[key])).toEqual(placeholders(source[key]));
        if (locale !== "en") expect(toasts[key]).not.toBe(source[key]);
      }
      expect(toasts.refreshedNoChange).toMatch(/[:：]/);
      expect(toasts.refreshedNoChange).not.toMatch(/—|--/);
      const notifications = read(locale, "common").notifications;
      for (const key of ["taskCompletedToast", "taskCancelledToast"]) {
        expect(notifications[key]).toBeTruthy();
        expect(placeholders(notifications[key])).toEqual(["{{name}}"]);
        if (locale !== "en") {
          expect(notifications[key]).not.toBe(
            read("en", "common").notifications[key]
          );
        }
      }
    }
  );
});
