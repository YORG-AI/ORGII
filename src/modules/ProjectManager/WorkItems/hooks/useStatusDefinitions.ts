import { useAtomValue } from "jotai";
import React, { useCallback, useMemo } from "react";

import {
  type StatusDefinition,
  projectApi,
  statusDefinitionsCacheKey,
} from "@src/api/http/project";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { useProjectCachedResource } from "@src/hooks/project";
import { projectStatusDefinitionsVersionAtom } from "@src/hooks/project/useProjectDataChanged";
import { CircleIcon, HugeiconsIcon } from "@src/icons";
import { STATUS_COLORS } from "@src/modules/ProjectManager/config/manage";
import type { DropdownOption } from "@src/types/core/shared";

const EMPTY_STATUS_DEFINITIONS: StatusDefinition[] = [];

function useStatusDefinitionsResource(orgId: string | null): {
  definitions: StatusDefinition[];
  refresh: () => Promise<void>;
} {
  const versions = useAtomValue(projectStatusDefinitionsVersionAtom);
  const version = orgId ? (versions[orgId] ?? 0) : 0;
  const read = useCallback(
    () =>
      orgId
        ? projectApi.listStatusDefinitions(orgId, true)
        : Promise.resolve(EMPTY_STATUS_DEFINITIONS),
    [orgId]
  );
  const { data, refresh: refreshResource } = useProjectCachedResource({
    cacheKey: orgId ? statusDefinitionsCacheKey(orgId, true) : null,
    read,
    empty: EMPTY_STATUS_DEFINITIONS,
    refreshToken: version,
  });
  const refresh = useCallback(async (): Promise<void> => {
    await refreshResource();
  }, [refreshResource]);

  return {
    definitions: data,
    refresh,
  };
}

/** Fetch and cache every custom status, including archived definitions.
 * Historical work items still need archived definitions for labels and
 * category semantics; selection hooks filter them out below. */
export function useEnsureStatusDefinitions(
  orgId: string | null
): () => Promise<void> {
  return useStatusDefinitionsResource(orgId).refresh;
}

export function useCustomStatusDefinitions(
  orgId: string | null
): StatusDefinition[] {
  return useStatusDefinitionsResource(orgId).definitions;
}

export function statusDefinitionToOption(
  definition: StatusDefinition
): DropdownOption<string> {
  return {
    value: definition.key,
    label: definition.name,
    icon: React.createElement(HugeiconsIcon, {
      icon: CircleIcon,
      size: DROPDOWN_ITEM.iconSize,
    }),
    color:
      definition.color ||
      STATUS_COLORS[definition.category] ||
      "var(--color-text-3)",
  };
}

export function getSelectableStatusDefinitions(
  definitions: readonly StatusDefinition[]
): StatusDefinition[] {
  return definitions.filter((definition) => definition.archivedAt == null);
}

/** Dropdown options for the org's custom statuses, appended after the
 * built-in options by every status picker. */
export function useCustomStatusOptions(
  orgId: string | null
): DropdownOption<string>[] {
  const definitions = useCustomStatusDefinitions(orgId);
  return useMemo(
    () =>
      getSelectableStatusDefinitions(definitions).map(statusDefinitionToOption),
    [definitions]
  );
}

/** Display-only options include archived definitions so a historical current
 * value keeps its name/color without making that value selectable again. */
export function useAllCustomStatusOptions(
  orgId: string | null
): DropdownOption<string>[] {
  const definitions = useCustomStatusDefinitions(orgId);
  return useMemo(
    () => definitions.map(statusDefinitionToOption),
    [definitions]
  );
}

/** status → category for custom keys, identity for everything else. */
export function resolveStatusCategory(
  status: string,
  definitions: StatusDefinition[]
): string {
  return (
    definitions.find((definition) => definition.key === status)?.category ??
    status
  );
}

export function useStatusCategoryResolver(
  orgId: string | null
): (status: string) => string {
  const definitions = useCustomStatusDefinitions(orgId);
  return useMemo(
    () => (status: string) => resolveStatusCategory(status, definitions),
    [definitions]
  );
}
