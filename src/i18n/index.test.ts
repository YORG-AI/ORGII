import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSystemLanguage } from "./index";

function useBrowserLanguages(language: string, languages = [language]): void {
  vi.stubGlobal("navigator", { language, languages });
}

describe("resolveSystemLanguage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"])(
    "maps %s to Traditional Chinese",
    (language) => {
      useBrowserLanguages(language);

      expect(resolveSystemLanguage()).toBe("zh-Hant");
    }
  );

  it.each(["zh-CN", "zh-SG", "zh-Hans", "zh-Hans-CN"])(
    "keeps %s on Simplified Chinese",
    (language) => {
      useBrowserLanguages(language);

      expect(resolveSystemLanguage()).toBe("zh");
    }
  );

  it.each([
    ["fr-CA", "fr"],
    ["pt-BR", "pt"],
    ["ja-JP", "ja"],
  ] as const)(
    "resolves %s through its supported base locale",
    (language, expected) => {
      useBrowserLanguages(language);

      expect(resolveSystemLanguage()).toBe(expected);
    }
  );

  it("continues through the browser preference list after an unsupported locale", () => {
    useBrowserLanguages("xx-ZZ", ["xx-ZZ", "zh-HK", "en-US"]);

    expect(resolveSystemLanguage()).toBe("zh-Hant");
  });

  it("falls back to English when no browser locale is supported", () => {
    useBrowserLanguages("xx-ZZ", ["xx-ZZ", "yy-AA"]);

    expect(resolveSystemLanguage()).toBe("en");
  });
});
