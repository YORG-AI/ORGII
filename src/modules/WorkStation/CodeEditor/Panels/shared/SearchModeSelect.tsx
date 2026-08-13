/**
 * SearchModeSelect Component
 *
 * Shared search mode selector dropdown used in both:
 * - Primary sidebar SearchContent
 * - Search editor tab SearchBar
 *
 * Uses the Select component for consistent styling.
 */
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  SEARCH_WRAPPER_PANE_INPUT,
  SEARCH_WRAPPER_SIDEBAR,
} from "@src/components/SearchInput/searchControlInputStyles";
import Select from "@src/components/Select";
import type { ControlAppearance } from "@src/components/controlAppearance";

// ============================================
// Types
// ============================================

export type SearchMode = "regex" | "semantic" | "hybrid";

export interface SearchModeSelectProps {
  /** Current search mode */
  value: SearchMode;
  /** Callback when mode changes */
  onChange: (mode: SearchMode) => void;
  /** Whether advanced search modes are available */
  advancedAvailable?: boolean;
  /** Whether the selector is disabled */
  disabled?: boolean;
  /** Size variant */
  size?: "small" | "default" | "large";
  /** Visual appearance - "default" has bg/border, "ghost" has none */
  appearance?: ControlAppearance;
  /** Background surface token for the selector box */
  surface?: "default" | "pane";
  /** Additional class name */
  className?: string;
}

// ============================================
// Search Mode Options
// ============================================

/**
 * Search mode options configuration
 * - value: mode identifier
 * - label: shown in dropdown list (not localized - technical terms)
 * - triggerLabel: shown when selected (in trigger)
 */
export const SEARCH_MODE_OPTIONS = [
  {
    value: "regex" as const,
    label: "Regex",
    triggerLabel: "Regex Search",
    advancedOnly: false,
  },
  {
    value: "semantic" as const,
    label: "Semantic",
    triggerLabel: "Semantic Search",
    advancedOnly: true,
  },
  {
    value: "hybrid" as const,
    label: "Hybrid",
    triggerLabel: "Hybrid Search",
    advancedOnly: true,
  },
];

// ============================================
// Component
// ============================================

export const SearchModeSelect: React.FC<SearchModeSelectProps> = memo(
  ({
    value,
    onChange,
    advancedAvailable = false,
    disabled = false,
    size = "small",
    appearance = "default",
    surface = "default",
    className = "",
  }) => {
    const { t } = useTranslation();
    const options = useMemo(
      () =>
        SEARCH_MODE_OPTIONS.filter(
          (option) => advancedAvailable || !option.advancedOnly
        ).map((option) => ({
          value: option.value,
          label: option.label,
          triggerLabel: option.triggerLabel,
        })),
      [advancedAvailable]
    );
    const handleChange = useCallback(
      (newValue: string | number | (string | number)[]) => {
        if (typeof newValue === "string") {
          onChange(newValue as SearchMode);
        }
      },
      [onChange]
    );

    const selectorClassName =
      surface === "pane"
        ? `${SEARCH_WRAPPER_SIDEBAR} ${SEARCH_WRAPPER_PANE_INPUT}`
        : SEARCH_WRAPPER_SIDEBAR;

    return (
      <div className={className}>
        <Select
          value={value}
          onChange={handleChange}
          options={options}
          size={size}
          placeholder={t("placeholders.searchMode")}
          disabled={disabled}
          appearance={appearance}
          selectorClassName={selectorClassName}
        />
      </div>
    );
  }
);

SearchModeSelect.displayName = "SearchModeSelect";

export default SearchModeSelect;
