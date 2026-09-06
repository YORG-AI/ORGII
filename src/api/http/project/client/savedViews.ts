/**
 * Org-shared saved views over the work item Table / Board.
 */
import { invoke } from "@tauri-apps/api/core";

import type { SavedView, UpsertSavedViewRequest } from "../types";

export async function listSavedViews(
  orgId: string,
  projectSlug?: string | null
): Promise<SavedView[]> {
  return invoke("project_list_saved_views", {
    orgId,
    projectSlug: projectSlug ?? null,
  });
}

export async function upsertSavedView(
  request: UpsertSavedViewRequest
): Promise<SavedView> {
  return invoke("project_upsert_saved_view", { request });
}

export async function archiveSavedView(
  orgId: string,
  id: string
): Promise<SavedView> {
  return invoke("project_archive_saved_view", { orgId, id });
}
