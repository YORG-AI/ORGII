/**
 * Batch work item mutations.
 */
import { invoke } from "@tauri-apps/api/core";

import { invalidateCache } from "../cache";
import type {
  BatchDeleteResult,
  BatchUpdateResult,
  WorkItemPartialUpdate,
} from "../types";

export async function batchDeleteWorkItems(
  projectSlug: string,
  shortIds: string[]
): Promise<BatchDeleteResult> {
  const result = await invoke<BatchDeleteResult>(
    "project_batch_delete_work_items",
    { projectSlug, shortIds }
  );
  invalidateCache(projectSlug);
  return result;
}

export async function batchUpdateWorkItems(
  projectSlug: string,
  shortIds: string[],
  updates: WorkItemPartialUpdate
): Promise<BatchUpdateResult> {
  const result = await invoke<BatchUpdateResult>(
    "project_batch_update_work_items",
    { projectSlug, shortIds, updates }
  );
  invalidateCache(projectSlug);
  return result;
}
