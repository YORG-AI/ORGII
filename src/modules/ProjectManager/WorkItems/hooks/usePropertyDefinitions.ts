import { useCallback } from "react";

import {
  type PropertyDefinition,
  projectApi,
  propertyDefinitionsCacheKey,
} from "@src/api/http/project";
import { useProjectCachedResource } from "@src/hooks/project";

const EMPTY_PROPERTY_DEFINITIONS: PropertyDefinition[] = [];

export function usePropertyDefinitions(orgId: string, enabled = true) {
  const read = useCallback(
    () => projectApi.listPropertyDefinitions(orgId),
    [orgId]
  );
  return useProjectCachedResource({
    cacheKey: propertyDefinitionsCacheKey(orgId),
    read,
    empty: EMPTY_PROPERTY_DEFINITIONS,
    enabled,
  });
}
