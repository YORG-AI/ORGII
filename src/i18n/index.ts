/**
 * i18n Configuration
 *
 * Internationalization setup using react-i18next.
 * Supports namespace-based translation files for modular organization.
 *
 * Performance: only the active language is loaded synchronously into the main
 * bundle. All other languages are loaded on-demand when `changeLanguage()` is
 * called for the first time for that language.
 *
 * Usage:
 * ```tsx
 * import { useTranslation } from 'react-i18next';
 *
 * function MyComponent() {
 *   const { t } = useTranslation();
 *   return <button>{t('actions.save')}</button>;
 * }
 * ```
 */
import i18n from "i18next";
import type { Callback, Resource, TFunction } from "i18next";
import { initReactI18next } from "react-i18next";

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Supported languages in the application.
 *
 * Array order is the display order in the language selector dropdown.
 * Ordered by approximate global native-speaker population (most-spoken first)
 * so the most likely match is closest to the top for new users.
 *
 * - en: English
 * - fr: French (Français)
 * - zh: Simplified Chinese (简体中文)
 * - zh-Hant: Traditional Chinese (繁體中文)
 * - es: Spanish (Español)
 * - ru: Russian (Русский)
 * - pt: Portuguese (Português)
 * - de: German (Deutsch)
 * - ja: Japanese (日本語)
 * - ko: Korean (한국어)
 * - tr: Turkish (Türkçe)
 * - vi: Vietnamese (Tiếng Việt)
 * - pl: Polish (Polski)
 */
export const SUPPORTED_LANGUAGES = [
  "en",
  "fr",
  "zh",
  "zh-Hant",
  "es",
  "ru",
  "pt",
  "de",
  "ja",
  "ko",
  "tr",
  "vi",
  "pl",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_PREFERENCE = {
  SYSTEM: "system",
} as const;

export const LANGUAGE_PREFERENCES = [
  LANGUAGE_PREFERENCE.SYSTEM,
  ...SUPPORTED_LANGUAGES,
] as const;

export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

/**
 * Default language - used when no preference is set
 */
const DEFAULT_LANGUAGE: SupportedLanguage = "en";
const DEFAULT_LANGUAGE_PREFERENCE: LanguagePreference =
  LANGUAGE_PREFERENCE.SYSTEM;

/**
 * Language display names in their native form
 * Used in the language selector UI
 */
export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  fr: "Français",
  zh: "简体中文",
  "zh-Hant": "繁體中文",
  es: "Español",
  ru: "Русский",
  pt: "Português",
  de: "Deutsch",
  ja: "日本語",
  ko: "한국어",
  tr: "Türkçe",
  vi: "Tiếng Việt",
  pl: "Polski",
};

const LANGUAGE_ENGLISH_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  fr: "French",
  zh: "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  es: "Spanish",
  ru: "Russian",
  pt: "Portuguese",
  de: "German",
  ja: "Japanese",
  ko: "Korean",
  tr: "Turkish",
  vi: "Vietnamese",
  pl: "Polish",
};

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.includes(value as SupportedLanguage);
}

function isLanguagePreference(value: string): value is LanguagePreference {
  return value === LANGUAGE_PREFERENCE.SYSTEM || isSupportedLanguage(value);
}

function resolveSystemLanguage(): SupportedLanguage {
  if (typeof navigator === "undefined") return DEFAULT_LANGUAGE;
  const browserLanguages = [navigator.language, ...navigator.languages].filter(
    Boolean
  );

  for (const browserLanguage of browserLanguages) {
    if (isSupportedLanguage(browserLanguage)) {
      return browserLanguage;
    }

    const baseLanguage = browserLanguage.split("-")[0];
    if (isSupportedLanguage(baseLanguage)) {
      return baseLanguage;
    }
  }

  return DEFAULT_LANGUAGE;
}

function normalizeLanguagePreference(
  value: string | null | undefined
): LanguagePreference {
  if (!value) return DEFAULT_LANGUAGE_PREFERENCE;
  return isLanguagePreference(value) ? value : DEFAULT_LANGUAGE_PREFERENCE;
}

export function resolveLanguagePreference(
  preference: string | null | undefined
): SupportedLanguage {
  const normalizedPreference = normalizeLanguagePreference(preference);
  return normalizedPreference === LANGUAGE_PREFERENCE.SYSTEM
    ? resolveSystemLanguage()
    : normalizedPreference;
}

export function getFollowSystemLanguageLabel(
  followSystemLabel = "Follow system"
): string {
  return `${followSystemLabel} (${LANGUAGE_ENGLISH_NAMES[resolveSystemLanguage()]})`;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Available namespaces
 * - common: Shared UI strings (buttons, status, errors)
 * - settings: Settings pages
 * - auth: Login/authentication pages
 * - onboarding: In-app tutorials
 * - navigation: Routes, app grid, tabs
 * - market: SelectRepo, Billing, Wallet, Market
 * - sessions: Session history, kanban, workspace
 * - projects: Projects & Work Items (TaskTracker)
 * - geo: Countries, timezone labels, timezone aliases
 * - profile: User profile (dev passport, bio, skills, education, experience)
 * - integrations: Integrations (channels, code accounts), Extensions (skills), ATC
 * - builderProfile: Runtime → Profile (axes, highlights, evidence)
 * - teamRuntime: Runtime → Team (member runtime sharing, org telemetry row)
 * - terms: Legal notices, third-party disclaimers, responsible use notices
 * - workflow: Workflow page (design, explore, task view, status bar)
 */
const NAMESPACES = [
  "common",
  "settings",
  "auth",
  "onboarding",
  "navigation",
  "market",
  "integrations",
  "sessions",
  "projects",
  "geo",
  "profile",
  "builderProfile",
  "teamRuntime",
  "terms",
  "workflow",
] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Get persisted language from localStorage for synchronous i18n init.
 *
 * The canonical source of truth is settings.jsonc (loaded async via Tauri IPC),
 * but i18n must initialize synchronously before React mounts. The languageAtom
 * write-side mirrors the value to localStorage so this function can pick it up.
 * After settings load, useSettingsSync calls i18n.changeLanguage() to reconcile.
 */
function getPersistedLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem("app-language");
    if (stored) {
      return normalizeLanguagePreference(JSON.parse(stored));
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_LANGUAGE_PREFERENCE;
}

/**
 * Dynamically import all namespace JSON files for a given language.
 * Each language gets its own webpack chunk so only the active language
 * is loaded on startup.
 */
async function loadLanguageResources(
  lang: SupportedLanguage
): Promise<Record<string, unknown>> {
  switch (lang) {
    case "en":
      return {
        auth: (await import("./locales/en/auth.json")).default,
        common: (await import("./locales/en/common.json")).default,
        geo: (await import("./locales/en/geo.json")).default,
        profile: (await import("./locales/en/profile.json")).default,
        builderProfile: (await import("./locales/en/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/en/teamRuntime.json")).default,
        market: (await import("./locales/en/market.json")).default,
        integrations: (await import("./locales/en/integrations.json")).default,
        navigation: (await import("./locales/en/navigation.json")).default,
        onboarding: (await import("./locales/en/onboarding.json")).default,
        projects: (await import("./locales/en/projects.json")).default,
        sessions: (await import("./locales/en/sessions.json")).default,
        settings: (await import("./locales/en/settings.json")).default,
        terms: (await import("./locales/en/terms.json")).default,
        workflow: (await import("./locales/en/workflow.json")).default,
      };
    case "zh":
      return {
        auth: (await import("./locales/zh/auth.json")).default,
        common: (await import("./locales/zh/common.json")).default,
        geo: (await import("./locales/zh/geo.json")).default,
        profile: (await import("./locales/zh/profile.json")).default,
        builderProfile: (await import("./locales/zh/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/zh/teamRuntime.json")).default,
        market: (await import("./locales/zh/market.json")).default,
        integrations: (await import("./locales/zh/integrations.json")).default,
        navigation: (await import("./locales/zh/navigation.json")).default,
        onboarding: (await import("./locales/zh/onboarding.json")).default,
        projects: (await import("./locales/zh/projects.json")).default,
        sessions: (await import("./locales/zh/sessions.json")).default,
        settings: (await import("./locales/zh/settings.json")).default,
        terms: (await import("./locales/zh/terms.json")).default,
        workflow: (await import("./locales/zh/workflow.json")).default,
      };
    case "fr":
      return {
        auth: (await import("./locales/fr/auth.json")).default,
        common: (await import("./locales/fr/common.json")).default,
        geo: (await import("./locales/fr/geo.json")).default,
        profile: (await import("./locales/fr/profile.json")).default,
        builderProfile: (await import("./locales/fr/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/fr/teamRuntime.json")).default,
        market: (await import("./locales/fr/market.json")).default,
        integrations: (await import("./locales/fr/integrations.json")).default,
        navigation: (await import("./locales/fr/navigation.json")).default,
        onboarding: (await import("./locales/fr/onboarding.json")).default,
        projects: (await import("./locales/fr/projects.json")).default,
        sessions: (await import("./locales/fr/sessions.json")).default,
        settings: (await import("./locales/fr/settings.json")).default,
        terms: (await import("./locales/fr/terms.json")).default,
        workflow: (await import("./locales/fr/workflow.json")).default,
      };
    case "de":
      return {
        auth: (await import("./locales/de/auth.json")).default,
        common: (await import("./locales/de/common.json")).default,
        geo: (await import("./locales/de/geo.json")).default,
        profile: (await import("./locales/de/profile.json")).default,
        builderProfile: (await import("./locales/de/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/de/teamRuntime.json")).default,
        market: (await import("./locales/de/market.json")).default,
        integrations: (await import("./locales/de/integrations.json")).default,
        navigation: (await import("./locales/de/navigation.json")).default,
        onboarding: (await import("./locales/de/onboarding.json")).default,
        projects: (await import("./locales/de/projects.json")).default,
        sessions: (await import("./locales/de/sessions.json")).default,
        settings: (await import("./locales/de/settings.json")).default,
        terms: (await import("./locales/de/terms.json")).default,
        workflow: (await import("./locales/de/workflow.json")).default,
      };
    case "es":
      return {
        auth: (await import("./locales/es/auth.json")).default,
        common: (await import("./locales/es/common.json")).default,
        geo: (await import("./locales/es/geo.json")).default,
        profile: (await import("./locales/es/profile.json")).default,
        builderProfile: (await import("./locales/es/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/es/teamRuntime.json")).default,
        market: (await import("./locales/es/market.json")).default,
        integrations: (await import("./locales/es/integrations.json")).default,
        navigation: (await import("./locales/es/navigation.json")).default,
        onboarding: (await import("./locales/es/onboarding.json")).default,
        projects: (await import("./locales/es/projects.json")).default,
        sessions: (await import("./locales/es/sessions.json")).default,
        settings: (await import("./locales/es/settings.json")).default,
        terms: (await import("./locales/es/terms.json")).default,
        workflow: (await import("./locales/es/workflow.json")).default,
      };
    case "ja":
      return {
        auth: (await import("./locales/ja/auth.json")).default,
        common: (await import("./locales/ja/common.json")).default,
        geo: (await import("./locales/ja/geo.json")).default,
        profile: (await import("./locales/ja/profile.json")).default,
        builderProfile: (await import("./locales/ja/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/ja/teamRuntime.json")).default,
        market: (await import("./locales/ja/market.json")).default,
        integrations: (await import("./locales/ja/integrations.json")).default,
        navigation: (await import("./locales/ja/navigation.json")).default,
        onboarding: (await import("./locales/ja/onboarding.json")).default,
        projects: (await import("./locales/ja/projects.json")).default,
        sessions: (await import("./locales/ja/sessions.json")).default,
        settings: (await import("./locales/ja/settings.json")).default,
        terms: (await import("./locales/ja/terms.json")).default,
        workflow: (await import("./locales/ja/workflow.json")).default,
      };
    case "ko":
      return {
        auth: (await import("./locales/ko/auth.json")).default,
        common: (await import("./locales/ko/common.json")).default,
        geo: (await import("./locales/ko/geo.json")).default,
        profile: (await import("./locales/ko/profile.json")).default,
        builderProfile: (await import("./locales/ko/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/ko/teamRuntime.json")).default,
        market: (await import("./locales/ko/market.json")).default,
        integrations: (await import("./locales/ko/integrations.json")).default,
        navigation: (await import("./locales/ko/navigation.json")).default,
        onboarding: (await import("./locales/ko/onboarding.json")).default,
        projects: (await import("./locales/ko/projects.json")).default,
        sessions: (await import("./locales/ko/sessions.json")).default,
        settings: (await import("./locales/ko/settings.json")).default,
        terms: (await import("./locales/ko/terms.json")).default,
        workflow: (await import("./locales/ko/workflow.json")).default,
      };
    case "ru":
      return {
        auth: (await import("./locales/ru/auth.json")).default,
        common: (await import("./locales/ru/common.json")).default,
        geo: (await import("./locales/ru/geo.json")).default,
        profile: (await import("./locales/ru/profile.json")).default,
        builderProfile: (await import("./locales/ru/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/ru/teamRuntime.json")).default,
        market: (await import("./locales/ru/market.json")).default,
        integrations: (await import("./locales/ru/integrations.json")).default,
        navigation: (await import("./locales/ru/navigation.json")).default,
        onboarding: (await import("./locales/ru/onboarding.json")).default,
        projects: (await import("./locales/ru/projects.json")).default,
        sessions: (await import("./locales/ru/sessions.json")).default,
        settings: (await import("./locales/ru/settings.json")).default,
        terms: (await import("./locales/ru/terms.json")).default,
        workflow: (await import("./locales/ru/workflow.json")).default,
      };
    case "tr":
      return {
        auth: (await import("./locales/tr/auth.json")).default,
        common: (await import("./locales/tr/common.json")).default,
        geo: (await import("./locales/tr/geo.json")).default,
        profile: (await import("./locales/tr/profile.json")).default,
        builderProfile: (await import("./locales/tr/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/tr/teamRuntime.json")).default,
        market: (await import("./locales/tr/market.json")).default,
        integrations: (await import("./locales/tr/integrations.json")).default,
        navigation: (await import("./locales/tr/navigation.json")).default,
        onboarding: (await import("./locales/tr/onboarding.json")).default,
        projects: (await import("./locales/tr/projects.json")).default,
        sessions: (await import("./locales/tr/sessions.json")).default,
        settings: (await import("./locales/tr/settings.json")).default,
        terms: (await import("./locales/tr/terms.json")).default,
        workflow: (await import("./locales/tr/workflow.json")).default,
      };
    case "vi":
      return {
        auth: (await import("./locales/vi/auth.json")).default,
        common: (await import("./locales/vi/common.json")).default,
        geo: (await import("./locales/vi/geo.json")).default,
        profile: (await import("./locales/vi/profile.json")).default,
        builderProfile: (await import("./locales/vi/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/vi/teamRuntime.json")).default,
        market: (await import("./locales/vi/market.json")).default,
        integrations: (await import("./locales/vi/integrations.json")).default,
        navigation: (await import("./locales/vi/navigation.json")).default,
        onboarding: (await import("./locales/vi/onboarding.json")).default,
        projects: (await import("./locales/vi/projects.json")).default,
        sessions: (await import("./locales/vi/sessions.json")).default,
        settings: (await import("./locales/vi/settings.json")).default,
        terms: (await import("./locales/vi/terms.json")).default,
        workflow: (await import("./locales/vi/workflow.json")).default,
      };
    case "pt":
      return {
        auth: (await import("./locales/pt/auth.json")).default,
        common: (await import("./locales/pt/common.json")).default,
        geo: (await import("./locales/pt/geo.json")).default,
        profile: (await import("./locales/pt/profile.json")).default,
        builderProfile: (await import("./locales/pt/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/pt/teamRuntime.json")).default,
        market: (await import("./locales/pt/market.json")).default,
        integrations: (await import("./locales/pt/integrations.json")).default,
        navigation: (await import("./locales/pt/navigation.json")).default,
        onboarding: (await import("./locales/pt/onboarding.json")).default,
        projects: (await import("./locales/pt/projects.json")).default,
        sessions: (await import("./locales/pt/sessions.json")).default,
        settings: (await import("./locales/pt/settings.json")).default,
        terms: (await import("./locales/pt/terms.json")).default,
        workflow: (await import("./locales/pt/workflow.json")).default,
      };
    case "pl":
      return {
        auth: (await import("./locales/pl/auth.json")).default,
        common: (await import("./locales/pl/common.json")).default,
        geo: (await import("./locales/pl/geo.json")).default,
        profile: (await import("./locales/pl/profile.json")).default,
        builderProfile: (await import("./locales/pl/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/pl/teamRuntime.json")).default,
        market: (await import("./locales/pl/market.json")).default,
        integrations: (await import("./locales/pl/integrations.json")).default,
        navigation: (await import("./locales/pl/navigation.json")).default,
        onboarding: (await import("./locales/pl/onboarding.json")).default,
        projects: (await import("./locales/pl/projects.json")).default,
        sessions: (await import("./locales/pl/sessions.json")).default,
        settings: (await import("./locales/pl/settings.json")).default,
        terms: (await import("./locales/pl/terms.json")).default,
        workflow: (await import("./locales/pl/workflow.json")).default,
      };
    case "zh-Hant":
      return {
        auth: (await import("./locales/zh-Hant/auth.json")).default,
        common: (await import("./locales/zh-Hant/common.json")).default,
        geo: (await import("./locales/zh-Hant/geo.json")).default,
        profile: (await import("./locales/zh-Hant/profile.json")).default,
        builderProfile: (await import("./locales/zh-Hant/builderProfile.json"))
          .default,
        teamRuntime: (await import("./locales/zh-Hant/teamRuntime.json"))
          .default,
        market: (await import("./locales/zh-Hant/market.json")).default,
        integrations: (await import("./locales/zh-Hant/integrations.json"))
          .default,
        navigation: (await import("./locales/zh-Hant/navigation.json")).default,
        onboarding: (await import("./locales/zh-Hant/onboarding.json")).default,
        projects: (await import("./locales/zh-Hant/projects.json")).default,
        sessions: (await import("./locales/zh-Hant/sessions.json")).default,
        settings: (await import("./locales/zh-Hant/settings.json")).default,
        terms: (await import("./locales/zh-Hant/terms.json")).default,
        workflow: (await import("./locales/zh-Hant/workflow.json")).default,
      };
  }
}

/**
 * Load resources for a language into i18next bundles.
 * Safe to call multiple times — skips if already loaded.
 */
async function ensureLanguageLoaded(lang: SupportedLanguage): Promise<void> {
  const alreadyLoaded = NAMESPACES.every((ns) =>
    i18n.hasResourceBundle(lang, ns)
  );
  if (alreadyLoaded) return;

  const bundles = await loadLanguageResources(lang);
  for (const ns of NAMESPACES) {
    if (!i18n.hasResourceBundle(lang, ns)) {
      i18n.addResourceBundle(lang, ns, bundles[ns], true, true);
    }
  }
}

/**
 * Initialize i18next with only the active language loaded synchronously.
 * Other languages are loaded on demand when changeLanguage() is called.
 * Guard with isInitialized to prevent re-init on HMR updates.
 */
async function initI18n(): Promise<void> {
  if (i18n.isInitialized) return;

  const activeLang = resolveLanguagePreference(
    getPersistedLanguagePreference()
  );
  const activeResources = await loadLanguageResources(activeLang);

  // JSON imports produce plain objects compatible with i18next's Resource type at
  // runtime; the cast bridges the structural mismatch with `ResourceKey`.
  const resources: Resource = {
    [activeLang]: activeResources as Resource[string],
  };

  // Always include English as fallback if the active language is not English
  if (activeLang !== "en") {
    const enResources = await loadLanguageResources("en");
    resources["en"] = enResources as Resource[string];
  }

  await i18n.use(initReactI18next).init({
    resources,
    lng: activeLang,
    fallbackLng: "en",
    defaultNS: "common",
    ns: NAMESPACES,
    showSupportNotice: false,

    interpolation: {
      // React already escapes values, no need for i18next to do it again
      escapeValue: false,
    },

    react: {
      useSuspense: false,
    },
  });

  // Patch changeLanguage to lazy-load bundles before switching
  const originalChangeLanguage = i18n.changeLanguage.bind(i18n);
  i18n.changeLanguage = async (
    lang?: string,
    callback?: Callback
  ): Promise<TFunction> => {
    if (lang && SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
      await ensureLanguageLoaded(lang as SupportedLanguage);
    }
    return originalChangeLanguage(lang, callback);
  };
}

// ---------------------------------------------------------------------------
// HMR: Hot-reload translation JSON files without full page reload
// ---------------------------------------------------------------------------
declare const module: { hot?: { accept: () => void } };

if (module.hot) {
  module.hot.accept();

  if (i18n.isInitialized) {
    // Only reload bundles for languages that are already loaded
    const loadedLangs = SUPPORTED_LANGUAGES.filter((lang) =>
      NAMESPACES.some((ns) => i18n.hasResourceBundle(lang, ns))
    );
    for (const lang of loadedLangs) {
      loadLanguageResources(lang)
        .then((bundles) => {
          for (const ns of NAMESPACES) {
            i18n.addResourceBundle(lang, ns, bundles[ns], true, true);
          }
        })
        .catch(() => {});
    }
  }
}

// Start initialization immediately (module side-effect, as before).
// The promise is intentionally not awaited here — callers that need to wait
// should import and await `i18nReady`.
export const i18nReady: Promise<void> = initI18n();

export default i18n;
