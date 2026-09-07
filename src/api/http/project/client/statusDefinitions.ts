/**
 * Org-scoped custom status catalog (pm_status_definitions).
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import { notifyProjectStatusDefinitionsChanged } from "../events";
import type { StatusDefinition, UpsertStatusDefinitionRequest } from "../types";

export function statusDefinitionsCacheKey(
  orgId: string,
  includeArchived = false
): string {
  return `${orgId}:status-definitions:${includeArchived ? "all" : "active"}`;
}

export async function listStatusDefinitions(
  orgId: string,
  includeArchived = false
): Promise<StatusDefinition[]> {
  return cachedRead(statusDefinitionsCacheKey(orgId, includeArchived), () =>
    invoke("project_list_status_definitions", {
      orgId,
      includeArchived,
    })
  );
}

export async function upsertStatusDefinition(
  request: UpsertStatusDefinitionRequest
): Promise<StatusDefinition> {
  const result = await invoke<StatusDefinition>(
    "project_upsert_status_definition",
    { request }
  );
  invalidateCache(request.orgId);
  notifyProjectStatusDefinitionsChanged(request.orgId);
  return result;
}

export async function setStatusDefinitionArchived(
  orgId: string,
  id: string,
  archived: boolean
): Promise<StatusDefinition> {
  const result = await invoke<StatusDefinition>(
    "project_set_status_definition_archived",
    { orgId, id, archived }
  );
  invalidateCache(orgId);
  notifyProjectStatusDefinitionsChanged(orgId);
  return result;
}
