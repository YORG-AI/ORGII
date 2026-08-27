/**
 * Custom work item property definitions and per-item property values.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  PropertyDefinition,
  UpsertPropertyDefinitionRequest,
  WorkItemPropertyValue,
  WorkItemScope,
} from "../types";

export async function listPropertyDefinitions(
  orgId: string,
  includeArchived = false
): Promise<PropertyDefinition[]> {
  return invoke("project_list_property_definitions", {
    orgId,
    includeArchived,
  });
}

export async function upsertPropertyDefinition(
  request: UpsertPropertyDefinitionRequest
): Promise<PropertyDefinition> {
  return invoke("project_upsert_property_definition", { request });
}

export async function archivePropertyDefinition(
  propertyId: string
): Promise<PropertyDefinition> {
  return invoke("project_archive_property_definition", { propertyId });
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
