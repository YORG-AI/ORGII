/**
 * Hook for translating route labels
 *
 * Provides i18n support for route labels defined in routes.ts.
 *
 * Resolution order:
 *   1. Explicit override in ROUTE_LABEL_OVERRIDES (cross-namespace or non-standard keys)
 *   2. navigation:labels.{camelKey}  (canonical app/view names)
 *   3. navigation:routes.{camelKey}  (route-specific strings)
 *   4. Static English label from routes.ts
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import {
  type RouteInfo,
  type RouteLabelContext,
  getRouteLabel,
} from "@src/config/routes";

/**
 * Explicit overrides for labels that live outside the navigation namespace
 * or whose camelCase derivation doesn't match the actual key.
 *
 * Only add entries here when the auto-derived key is wrong.
 */
const ROUTE_LABEL_OVERRIDES: Record<string, string> = {
  Workstation: "common:terminology.workStation",
  "DB Manager": "labels.dbManager",
  "Code Accounts": "integrations:keyVault.title",
  Settings: "common:tabs.settings",
};

/** Convert "Work Items" → "workItems", "Code Editor" → "codeEditor" */
function toCamelKey(label: string): string {
  return label
    .split(/\s+/)
    .map((word, idx) =>
      idx === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join("");
}

export function useRouteLabel() {
  const { t } = useTranslation("navigation");

  /**
   * Resolve a translated label for a static route label string.
   * Tries: override → labels.* → routes.* → static fallback.
   */
  const resolveLabel = useCallback(
    (staticLabel: string): string => {
      const override = ROUTE_LABEL_OVERRIDES[staticLabel];
      if (override) return t(override);

      const camelKey = toCamelKey(staticLabel);

      const fromLabels = t(`labels.${camelKey}`, { defaultValue: "" });
      if (fromLabels) return fromLabels;

      const fromRoutes = t(`routes.${camelKey}`, { defaultValue: "" });
      if (fromRoutes) return fromRoutes;

      return staticLabel;
    },
    [t]
  );

  const getTranslatedRouteLabel = useCallback(
    (route: RouteInfo, context: RouteLabelContext = {}): string => {
      return resolveLabel(getRouteLabel(route, context));
    },
    [resolveLabel]
  );

  const getTranslatedLabelForPath = useCallback(
    (staticLabel: string, _context: RouteLabelContext = {}): string => {
      return resolveLabel(staticLabel);
    },
    [resolveLabel]
  );

  return {
    getTranslatedRouteLabel,
    getTranslatedLabelForPath,
  };
}
