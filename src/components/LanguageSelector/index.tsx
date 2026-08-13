/**
 * Language Selector Component
 *
 * Dropdown for selecting the application language.
 * Syncs with i18next and persists preference to settings.jsonc via languageAtom.
 *
 * @example
 * ```tsx
 * // In settings page
 * import { LanguageSelector } from "@src/components/LanguageSelector";
 *
 * <LanguageSelector />
 *
 * // Compact version for toolbar/header
 * <LanguageSelector size="small" appearance="ghost" />
 * ```
 */
import { useAtom } from "jotai";
import { Globe } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import type { ControlAppearance } from "@src/components/controlAppearance";
import {
  LANGUAGE_NAMES,
  LANGUAGE_PREFERENCE,
  type LanguagePreference,
  SUPPORTED_LANGUAGES,
  getFollowSystemLanguageLabel,
  resolveLanguagePreference,
} from "@src/i18n";
import { languageAtom } from "@src/store/ui/languageAtom";

// ============================================================================
// TYPES
// ============================================================================

export interface LanguageSelectorProps {
  /**
   * Size of the selector
   * @default 'default'
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Visual appearance
   * @default 'default'
   */
  appearance?: ControlAppearance;

  /**
   * Show globe icon prefix
   * @default true
   */
  showIcon?: boolean;

  /**
   * Additional class name
   */
  className?: string;

  /** Accessible name forwarded to the shared Select trigger. */
  ariaLabel?: string;

  /**
   * Callback when language changes
   */
  onLanguageChange?: (language: LanguagePreference) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function LanguageSelector({
  size = "default",
  appearance = "default",
  showIcon = true,
  className,
  ariaLabel,
  onLanguageChange,
}: LanguageSelectorProps) {
  const { i18n, t } = useTranslation("settings");
  const [languagePreference, setLanguagePreference] = useAtom(languageAtom);

  // Build options from supported languages
  const options: SelectOption[] = useMemo(
    () => [
      {
        value: LANGUAGE_PREFERENCE.SYSTEM,
        label: getFollowSystemLanguageLabel(t("general.followSystem")),
      },
      ...SUPPORTED_LANGUAGES.map((lang) => ({
        value: lang,
        label: LANGUAGE_NAMES[lang],
      })),
    ],
    [t]
  );

  // Handle language change
  const handleChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const newPreference = value as LanguagePreference;

      void i18n.changeLanguage(resolveLanguagePreference(newPreference));
      setLanguagePreference(newPreference);
      onLanguageChange?.(newPreference);
    },
    [i18n, setLanguagePreference, onLanguageChange]
  );

  return (
    <Select
      value={languagePreference}
      options={options}
      onChange={handleChange}
      size={size}
      appearance={appearance}
      prefix={showIcon ? <Globe className="h-4 w-4" /> : undefined}
      className={className}
      ariaLabel={ariaLabel}
      dropdownWidthMode="auto"
    />
  );
}

export default LanguageSelector;
