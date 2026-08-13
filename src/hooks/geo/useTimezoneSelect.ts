/**
 * useTimezoneSelect Hook
 *
 * Returns Select-compatible props for a searchable timezone selector.
 * Features: localized city labels, search by city/GMT offset/alias/region,
 * dynamic GMT offset & current time display, persisted alias display name.
 *
 * @example
 * ```tsx
 * const timezoneProps = useTimezoneSelect({ value: tz, onChange: setTz });
 * <Select {...timezoneProps} />
 * ```
 */
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption, SelectProps } from "@src/components/Select/types";
import {
  TIMEZONE_OPTIONS,
  type TimezoneOptionItem,
  getCurrentTimeForTimezone,
  getTimezoneOffset,
} from "@src/config/timezone";
import { usePersistedState } from "@src/hooks/storage";
import { STORAGE_KEYS } from "@src/hooks/storage/keys";

// ============================================
// Types
// ============================================

export interface UseTimezoneSelectOptions {
  /** Current timezone value (e.g. "America/Los_Angeles", "auto") */
  value: string;
  /** Called when user selects a timezone */
  onChange: (value: string) => void;
  /** Exclude "auto" option — use for profile where a real timezone is expected */
  excludeAuto?: boolean;
  /** Select size */
  size?: "mini" | "small" | "default" | "large";
  /** Prefix element (icon, etc.) */
  prefix?: ReactNode;
  /** Custom width style */
  style?: CSSProperties;
  /** Prefix for offset display. Defaults to Settings-style GMT labels. */
  offsetPrefix?: "GMT" | "UTC";
}

// ============================================
// Pure helpers
// ============================================

/** Show matched alias when user searched by an alias name */
function getDisplayLabel(
  timezoneItem: TimezoneOptionItem,
  search: string
): string {
  if (!search || search.length < 2) return timezoneItem.label;
  const searchLower = search.toLowerCase();
  const matchedAlias = timezoneItem.aliases?.find((alias) =>
    alias.toLowerCase().includes(searchLower)
  );
  return matchedAlias || timezoneItem.label;
}

/** Dynamic GMT offset string (e.g. "+8", "-5:30") */
function getDynamicOffset(timezoneValue: string): string {
  if (timezoneValue === "auto" || timezoneValue === "utc") return "";
  const { offset } = getTimezoneOffset(timezoneValue);
  if (offset === "0" || offset === "?") return "";
  if (offset.startsWith("-") || offset.startsWith("+")) return offset;
  return `+${offset}`;
}

/** Filter: matches label, translated label, offset (GMT+x), aliases, region */
function filterTimezone(
  inputValue: string,
  timezoneItem: TimezoneOptionItem,
  translatedLabel: string,
  translatedAliases: string
): boolean {
  const searchTerm = String(inputValue).toLowerCase();

  if (translatedLabel.toLowerCase().includes(searchTerm)) return true;

  if (
    timezoneItem.label.toLowerCase().includes(searchTerm) ||
    timezoneItem.value.toLowerCase().includes(searchTerm) ||
    timezoneItem.offset.includes(searchTerm)
  ) {
    return true;
  }

  if (`gmt${timezoneItem.offset}`.includes(searchTerm)) return true;

  const dynamicOffset = getDynamicOffset(timezoneItem.value);
  if (
    dynamicOffset &&
    `gmt${dynamicOffset}`.toLowerCase().includes(searchTerm)
  ) {
    return true;
  }

  if (
    timezoneItem.aliases?.some((alias: string) =>
      alias.toLowerCase().includes(searchTerm)
    )
  ) {
    return true;
  }

  if (
    translatedAliases &&
    translatedAliases.toLowerCase().includes(searchTerm)
  ) {
    return true;
  }

  if (timezoneItem.region?.toLowerCase().includes(searchTerm)) return true;

  return false;
}

// ============================================
// Hook
// ============================================

export function useTimezoneSelect({
  value,
  onChange,
  excludeAuto = false,
  size = "default",
  prefix,
  style,
  offsetPrefix = "GMT",
}: UseTimezoneSelectOptions): SelectProps {
  const { t: tSettings } = useTranslation("settings");
  const { t: tGeo } = useTranslation("geo");
  const [searchText, setSearchText] = useState("");
  const [displayName, setDisplayName] = usePersistedState<string | null>(
    STORAGE_KEYS.user.timezoneDisplayName,
    null
  );

  const baseOptions = useMemo(() => {
    const configuredOptions = excludeAuto
      ? TIMEZONE_OPTIONS.filter((option) => option.value !== "auto")
      : TIMEZONE_OPTIONS;
    if (
      value === "auto" ||
      value === "utc" ||
      configuredOptions.some((option) => option.value === value)
    ) {
      return configuredOptions;
    }

    const city = value.split("/").at(-1)?.replace(/_/g, " ") || value;
    const { offset, offsetMinutes } = getTimezoneOffset(value);
    return [
      ...configuredOptions,
      {
        value,
        label: city,
        labelKey: value.toLowerCase().replace(/\//g, "_"),
        offset,
        offsetMinutes,
        region: value.split("/")[0],
      },
    ];
  }, [excludeAuto, value]);

  /** Resolve localized label for a timezone item */
  const getLocalizedLabel = useCallback(
    (item: TimezoneOptionItem): string => {
      if (item.value === "auto") return tSettings("general.timezoneAuto");
      const translated = tGeo(`timezoneLabels.${item.labelKey}`, {
        defaultValue: "",
      });
      return translated || item.label;
    },
    [tSettings, tGeo]
  );

  const getSelectedDisplayName = useCallback(
    (timezoneValue: string): string => {
      if (displayName) return displayName;
      const timezoneItem = baseOptions.find(
        (item) => item.value === timezoneValue
      );
      return timezoneItem ? getLocalizedLabel(timezoneItem) : timezoneValue;
    },
    [displayName, baseOptions, getLocalizedLabel]
  );

  const options: SelectOption[] = useMemo(() => {
    return baseOptions.map((timezoneItem) => {
      const localizedLabel = getLocalizedLabel(timezoneItem);
      const itemLabel =
        searchText.length >= 2
          ? getDisplayLabel(timezoneItem, searchText) === timezoneItem.label
            ? localizedLabel
            : getDisplayLabel(timezoneItem, searchText)
          : localizedLabel;
      const dynamicOffset = getDynamicOffset(timezoneItem.value);
      const currentTime = getCurrentTimeForTimezone(timezoneItem.value);

      const parts = [itemLabel];
      if (dynamicOffset) parts.push(`${offsetPrefix}${dynamicOffset}`);
      if (currentTime) parts.push(currentTime);

      const isSelected = timezoneItem.value === value;

      let label: string;
      if (isSelected) {
        const selectedLabel = getSelectedDisplayName(timezoneItem.value);
        const selectedParts = [selectedLabel];
        if (dynamicOffset)
          selectedParts.push(`${offsetPrefix}${dynamicOffset}`);
        if (currentTime) selectedParts.push(currentTime);
        label = selectedParts.join(" · ");
      } else {
        label = parts.join(" · ");
      }

      return { label, value: timezoneItem.value };
    });
  }, [
    value,
    searchText,
    getSelectedDisplayName,
    getLocalizedLabel,
    baseOptions,
    offsetPrefix,
  ]);

  /** Find matching alias (English or localized) from search text */
  const findMatchedAlias = useCallback(
    (item: TimezoneOptionItem, search: string): string | null => {
      if (!search || search.length < 2) return null;
      const searchLower = search.toLowerCase();

      const englishMatch = item.aliases?.find((alias) =>
        alias.toLowerCase().includes(searchLower)
      );
      if (englishMatch) return englishMatch;

      const translated = tGeo(`timezoneAliases.${item.labelKey}`, {
        defaultValue: "",
      });
      if (translated) {
        const localizedMatch = translated
          .split(",")
          .map((alias) => alias.trim())
          .find((alias) => alias.toLowerCase().includes(searchLower));
        if (localizedMatch) return localizedMatch;
      }

      return null;
    },
    [tGeo]
  );

  const handleChange = useCallback(
    (selectedValue: string | number | (string | number)[]) => {
      const tzValue = String(selectedValue);
      const selectedTimezone = baseOptions.find(
        (item) => item.value === tzValue
      );

      if (selectedTimezone && searchText) {
        const matchedAlias = findMatchedAlias(selectedTimezone, searchText);
        setDisplayName(matchedAlias || null);
      } else {
        setDisplayName(null);
      }

      onChange(tzValue);
      setSearchText("");
    },
    [baseOptions, searchText, onChange, findMatchedAlias, setDisplayName]
  );

  const handleFilter = useCallback(
    (inputValue: string, option: { value: string | number }) => {
      const timezoneItem = baseOptions.find(
        (item) => item.value === option.value
      );
      if (!timezoneItem) return false;
      const translatedLabel = getLocalizedLabel(timezoneItem);
      const translatedAliases = tGeo(
        `timezoneAliases.${timezoneItem.labelKey}`,
        { defaultValue: "" }
      );
      return filterTimezone(
        inputValue,
        timezoneItem,
        translatedLabel,
        translatedAliases
      );
    },
    [baseOptions, getLocalizedLabel, tGeo]
  );

  return {
    value,
    onChange: handleChange,
    size,
    style,
    prefix,
    showSearch: true,
    placeholder: tSettings("general.timezoneSearchPlaceholder"),
    onSearch: setSearchText,
    filterOption: handleFilter,
    options,
  };
}
