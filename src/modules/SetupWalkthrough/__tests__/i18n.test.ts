import { describe, expect, it } from "vitest";

import deNavigation from "@src/i18n/locales/de/navigation.json";
import deOnboarding from "@src/i18n/locales/de/onboarding.json";
import enNavigation from "@src/i18n/locales/en/navigation.json";
import enOnboarding from "@src/i18n/locales/en/onboarding.json";
import esNavigation from "@src/i18n/locales/es/navigation.json";
import esOnboarding from "@src/i18n/locales/es/onboarding.json";
import frNavigation from "@src/i18n/locales/fr/navigation.json";
import frOnboarding from "@src/i18n/locales/fr/onboarding.json";
import jaNavigation from "@src/i18n/locales/ja/navigation.json";
import jaOnboarding from "@src/i18n/locales/ja/onboarding.json";
import koNavigation from "@src/i18n/locales/ko/navigation.json";
import koOnboarding from "@src/i18n/locales/ko/onboarding.json";
import plNavigation from "@src/i18n/locales/pl/navigation.json";
import plOnboarding from "@src/i18n/locales/pl/onboarding.json";
import ptNavigation from "@src/i18n/locales/pt/navigation.json";
import ptOnboarding from "@src/i18n/locales/pt/onboarding.json";
import ruNavigation from "@src/i18n/locales/ru/navigation.json";
import ruOnboarding from "@src/i18n/locales/ru/onboarding.json";
import trNavigation from "@src/i18n/locales/tr/navigation.json";
import trOnboarding from "@src/i18n/locales/tr/onboarding.json";
import viNavigation from "@src/i18n/locales/vi/navigation.json";
import viOnboarding from "@src/i18n/locales/vi/onboarding.json";
import zhHantNavigation from "@src/i18n/locales/zh-Hant/navigation.json";
import zhHantOnboarding from "@src/i18n/locales/zh-Hant/onboarding.json";
import zhNavigation from "@src/i18n/locales/zh/navigation.json";
import zhOnboarding from "@src/i18n/locales/zh/onboarding.json";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";

type TranslationTree = Record<string, unknown>;

const LOCALES = {
  de: { onboarding: deOnboarding, navigation: deNavigation },
  en: { onboarding: enOnboarding, navigation: enNavigation },
  es: { onboarding: esOnboarding, navigation: esNavigation },
  fr: { onboarding: frOnboarding, navigation: frNavigation },
  ja: { onboarding: jaOnboarding, navigation: jaNavigation },
  ko: { onboarding: koOnboarding, navigation: koNavigation },
  pl: { onboarding: plOnboarding, navigation: plNavigation },
  pt: { onboarding: ptOnboarding, navigation: ptNavigation },
  ru: { onboarding: ruOnboarding, navigation: ruNavigation },
  tr: { onboarding: trOnboarding, navigation: trNavigation },
  vi: { onboarding: viOnboarding, navigation: viNavigation },
  zh: { onboarding: zhOnboarding, navigation: zhNavigation },
  "zh-Hant": {
    onboarding: zhHantOnboarding,
    navigation: zhHantNavigation,
  },
} as const;

function flatten(
  tree: TranslationTree,
  prefix = "",
  result: Record<string, string> = {}
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      flatten(value as TranslationTree, path, result);
    } else {
      result[path] = String(value);
    }
  }
  return result;
}

function interpolationVariables(value: string): string[] {
  return [...value.matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]).sort();
}

function readPath(tree: TranslationTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as TranslationTree)[segment];
  }, tree);
}

describe("setup walkthrough i18n contract", () => {
  const english = flatten({
    readiness: enOnboarding.readiness,
    tutorials: enOnboarding.tutorials,
  });

  it("keeps the setup and tutorial key shape complete in every locale", () => {
    for (const [locale, resources] of Object.entries(LOCALES)) {
      const translated = flatten({
        readiness: resources.onboarding.readiness,
        tutorials: resources.onboarding.tutorials,
      });

      expect(Object.keys(translated).sort(), locale).toEqual(
        Object.keys(english).sort()
      );
      expect(
        Object.values(translated).every((value) => value.trim().length > 0),
        locale
      ).toBe(true);
    }
  });

  it("keeps the sidebar guide key shape complete in every locale", () => {
    const englishGuide = flatten(enNavigation.sidebar.guide);

    for (const [locale, resources] of Object.entries(LOCALES)) {
      const translatedGuide = flatten(resources.navigation.sidebar.guide);
      expect(Object.keys(translatedGuide).sort(), locale).toEqual(
        Object.keys(englishGuide).sort()
      );
      expect(
        Object.values(translatedGuide).every(
          (value) => value.trim().length > 0
        ),
        locale
      ).toBe(true);
    }
  });

  it("keeps the developer test panel key shape complete in every locale", () => {
    const englishPanel = flatten(enNavigation.sidebar.developerTestPanel);

    for (const [locale, resources] of Object.entries(LOCALES)) {
      const translatedPanel = flatten(
        resources.navigation.sidebar.developerTestPanel
      );
      expect(Object.keys(translatedPanel).sort(), locale).toEqual(
        Object.keys(englishPanel).sort()
      );
      expect(
        Object.values(translatedPanel).every(
          (value) => value.trim().length > 0
        ),
        locale
      ).toBe(true);
    }
  });

  it("preserves interpolation variables and rejects migration artifacts", () => {
    for (const [locale, resources] of Object.entries(LOCALES)) {
      const translated = flatten({
        readiness: resources.onboarding.readiness,
        tutorials: resources.onboarding.tutorials,
      });

      for (const [key, englishValue] of Object.entries(english)) {
        expect(
          interpolationVariables(translated[key]),
          `${locale}:${key}`
        ).toEqual(interpolationVariables(englishValue));
        expect(translated[key], `${locale}:${key}`).not.toMatch(
          /__KEEP_|__ITEM_|__ELEMENT_|<x\d+>|\uE000|\uE001/
        );
      }
    }
  });

  it("does not silently fall back to the English onboarding for other locales", () => {
    for (const [locale, resources] of Object.entries(LOCALES)) {
      if (locale === "en") continue;
      const translated = flatten({
        readiness: resources.onboarding.readiness,
        tutorials: resources.onboarding.tutorials,
      });
      const unchangedCount = Object.keys(english).filter(
        (key) => translated[key] === english[key]
      ).length;

      // Product names and keyboard glyphs may intentionally stay unchanged.
      expect(unchangedCount, locale).toBeLessThan(30);
    }
  });

  it("covers the tutorial registry and setup-checklist navigation entry", () => {
    for (const [locale, resources] of Object.entries(LOCALES)) {
      expect(
        resources.navigation.sidebar.settingsMenu.setupChecklist,
        locale
      ).toBeTruthy();

      for (const tutorial of TUTORIALS) {
        expect(
          readPath(resources.onboarding, tutorial.titleKey),
          `${locale}:${tutorial.titleKey}`
        ).toBeTruthy();
        expect(
          readPath(resources.onboarding, tutorial.descriptionKey),
          `${locale}:${tutorial.descriptionKey}`
        ).toBeTruthy();
        expect(
          readPath(resources.onboarding, tutorial.durationKey),
          `${locale}:${tutorial.durationKey}`
        ).toBeTruthy();
      }
    }
  });

  it("keeps the localized tutorial keyboard hint intact", () => {
    for (const [locale, resources] of Object.entries(LOCALES)) {
      const hint = resources.onboarding.tutorials.chrome.keyboardHint;
      expect(hint, locale).toContain("←");
      expect(hint, locale).toContain("→");
      expect(hint, locale).toContain("< / >");
    }
  });
});
