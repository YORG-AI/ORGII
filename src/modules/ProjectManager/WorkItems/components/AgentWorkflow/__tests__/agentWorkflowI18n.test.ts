import { describe, expect, it } from "vitest";

import deProjects from "@src/i18n/locales/de/projects.json";
import enProjects from "@src/i18n/locales/en/projects.json";
import esProjects from "@src/i18n/locales/es/projects.json";
import frProjects from "@src/i18n/locales/fr/projects.json";
import jaProjects from "@src/i18n/locales/ja/projects.json";
import koProjects from "@src/i18n/locales/ko/projects.json";
import plProjects from "@src/i18n/locales/pl/projects.json";
import ptProjects from "@src/i18n/locales/pt/projects.json";
import ruProjects from "@src/i18n/locales/ru/projects.json";
import trProjects from "@src/i18n/locales/tr/projects.json";
import viProjects from "@src/i18n/locales/vi/projects.json";
import zhHantProjects from "@src/i18n/locales/zh-Hant/projects.json";
import zhProjects from "@src/i18n/locales/zh/projects.json";

import { ROLE_I18N_KEYS, STATUS_I18N_KEYS } from "../types";

type TranslationTree = Record<string, unknown>;

const PROJECT_LOCALES = {
  de: deProjects,
  en: enProjects,
  es: esProjects,
  fr: frProjects,
  ja: jaProjects,
  ko: koProjects,
  pl: plProjects,
  pt: ptProjects,
  ru: ruProjects,
  tr: trProjects,
  vi: viProjects,
  zh: zhProjects,
  "zh-Hant": zhHantProjects,
} as const;

function readTranslation(tree: TranslationTree, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as TranslationTree)[segment];
  }, tree);
}

describe("Agent Workflow i18n mappings", () => {
  it("resolves every role and status label in every project locale", () => {
    const mappedKeys = new Set([
      ...Object.values(ROLE_I18N_KEYS),
      ...Object.values(STATUS_I18N_KEYS),
    ]);

    for (const [locale, projects] of Object.entries(PROJECT_LOCALES)) {
      for (const key of mappedKeys) {
        const translated = readTranslation(projects, key);
        expect(typeof translated, `${locale}:${key}`).toBe("string");
        expect(
          String(translated).trim().length,
          `${locale}:${key}`
        ).toBeGreaterThan(0);
      }
    }
  });
});
