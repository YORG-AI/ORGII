/**
 * usePathSegment
 *
 * Resolves a PathConfig (label + template) into the spotlight path-segment
 * shape consumed by SelectorScaffold's `path` prop. Translates `i18nLabel` /
 * `i18nTemplate` keys at render time and applies optional caller overrides.
 *
 * Returns an array of length 0 or 1 so callers can spread directly into the
 * `path` prop without conditional branching.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { IconSvgElement } from "@src/icons";

import { type PathConfig, buildPathSegment } from "../palettes/config";

export interface UsePathSegmentOptions {
  /** Force a specific label string, bypassing config + i18n. */
  labelOverride?: string;
  /** Force a specific template string, bypassing config + i18n. */
  templateOverride?: string;
  /** Force a specific icon, bypassing the config's default. */
  iconOverride?: IconSvgElement;
  /** When true, returns an empty array regardless of config. */
  disabled?: boolean;
}

type PathSegment = ReturnType<typeof buildPathSegment>;

export function usePathSegment(
  config: PathConfig | undefined,
  options: UsePathSegmentOptions = {}
): PathSegment[] {
  const { t } = useTranslation();
  const { labelOverride, templateOverride, iconOverride, disabled } = options;

  return useMemo(() => {
    if (!config || disabled) {
      return [];
    }

    const resolvedLabel =
      labelOverride ??
      (config.i18nLabel
        ? t(config.i18nLabel, { ns: config.i18nNs })
        : config.label);

    const resolvedTemplate =
      templateOverride ??
      (config.i18nTemplate
        ? t(config.i18nTemplate, { ns: config.i18nNs })
        : config.template);

    const segment = buildPathSegment(config);

    return [
      {
        ...segment,
        label: resolvedLabel,
        icon: iconOverride ?? segment.icon,
        data: {
          ...segment.data,
          template: resolvedTemplate,
        },
      },
    ];
  }, [config, labelOverride, templateOverride, iconOverride, disabled, t]);
}
