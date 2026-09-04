import { projectApi } from "@src/api/http/project";
import type { WorkItem } from "@src/types/core/workItem";

import { toWorkItemPartialUpdate } from "./workItemPartialUpdate";

/**
 * Shared write boundary for UI work-item edits. Callers keep their own source
 * identity, reconciliation, and error policy; empty edits never reach storage.
 */
export async function applyWorkItemUpdate(
  projectSlug: string,
  workItemId: string,
  updates: Partial<WorkItem>,
  actor?: Parameters<typeof toWorkItemPartialUpdate>[1]
) {
  const payload = toWorkItemPartialUpdate(updates, actor);
  if (Object.keys(payload).length === 0) return null;
  return projectApi.updateWorkItemPartial(projectSlug, workItemId, payload);
}
