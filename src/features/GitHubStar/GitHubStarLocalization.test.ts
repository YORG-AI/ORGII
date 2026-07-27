import de from "@src/i18n/locales/de/settings.json";
import en from "@src/i18n/locales/en/settings.json";
import es from "@src/i18n/locales/es/settings.json";
import fr from "@src/i18n/locales/fr/settings.json";
import ja from "@src/i18n/locales/ja/settings.json";
import ko from "@src/i18n/locales/ko/settings.json";
import pl from "@src/i18n/locales/pl/settings.json";
import pt from "@src/i18n/locales/pt/settings.json";
import ru from "@src/i18n/locales/ru/settings.json";
import tr from "@src/i18n/locales/tr/settings.json";
import vi from "@src/i18n/locales/vi/settings.json";
import zhHant from "@src/i18n/locales/zh-Hant/settings.json";
import zh from "@src/i18n/locales/zh/settings.json";

const locales = {
  de,
  en,
  es,
  fr,
  ja,
  ko,
  pl,
  pt,
  ru,
  tr,
  vi,
  "zh-Hant": zhHant,
  zh,
} as const;

const requiredReminderKeys = [
  "star",
  "openGitHub",
  "reminderTitle",
  "reminderDescription",
  "later",
  "neverAskAgain",
] as const;

describe("GitHub Star reminder localization", () => {
  it.each(Object.entries(locales))(
    "%s provides every user-visible reminder string",
    (_locale, resources) => {
      const githubStar = resources.general.githubStar;

      for (const key of requiredReminderKeys) {
        expect(githubStar[key]).toBeTypeOf("string");
        expect(githubStar[key].trim()).not.toBe("");
      }
    }
  );
});
