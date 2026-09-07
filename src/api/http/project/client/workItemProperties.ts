/**
 * Custom work item property definitions and per-item property values.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type {
  PropertyDefinition,
  UpsertPropertyDefinitionRequest,
  WorkItemPropertyValue,
  WorkItemScope,
} from "../types";

export function propertyDefinitionsCacheKey(
  orgId: string,
  includeArchived = false
): string {
  return `${orgId}:property-definitions:${includeArchived ? "all" : "active"}`;
}

export async function listPropertyDefinitions(
  orgId: string,
  includeArchived = false
): Promise<PropertyDefinition[]> {
  return cachedRead(propertyDefinitionsCacheKey(orgId, includeArchived), () =>
    invoke("project_list_property_definitions", {
      orgId,
      includeArchived,
    })
  );
}

export async function upsertPropertyDefinition(
  request: UpsertPropertyDefinitionRequest
): Promise<PropertyDefinition> {
  const result = await invoke<PropertyDefinition>(
    "project_upsert_property_definition",
    { request }
  );
  invalidateCache(request.orgId);
  return result;
}

export async function archivePropertyDefinition(
  propertyId: string,
  orgId: string
): Promise<PropertyDefinition> {
  const result = await invoke<PropertyDefinition>(
    "project_archive_property_definition",
    { propertyId }
  );
  invalidateCache(orgId);
  return result;
}

export async function listWorkItemPropertyValues(
  scope: WorkItemScope
): Promise<WorkItemPropertyValue[]> {
  return invoke("project_list_work_item_property_values", { scope });
}

export async function setWorkItemPropertyValue(
  scope: WorkItemScope,
  propertyId: string,
  value: unknown | null
): Promise<WorkItemPropertyValue | null> {
  return invoke("project_set_work_item_property_value", {
    request: { ...scope, propertyId, value },
  });
}

export async function listScopePropertyValues(
  orgId: string,
  projectSlug?: string | null
): Promise<import("../types").ScopePropertyValue[]> {
  return invoke("project_list_scope_property_values", {
    orgId,
    projectSlug: projectSlug ?? null,
  });
}

export async function batchSetWorkItemPropertyValue(input: {
  orgId: string;
  projectSlug?: string | null;
  shortIds: string[];
  propertyId: string;
  value: unknown | null;
}): Promise<number> {
  const result = await invoke<number>(
    "project_batch_set_work_item_property_value",
    {
      orgId: input.orgId,
      projectSlug: input.projectSlug ?? null,
      shortIds: input.shortIds,
      propertyId: input.propertyId,
      value: input.value,
    }
  );
  invalidateCache(input.projectSlug ?? undefined);
  return result;
}
