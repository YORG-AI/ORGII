/**
 * Work item run queue (`project_*_work_item_run*`) commands.
 */
import { invoke } from "@tauri-apps/api/core";

import type { EnqueueWorkItemRunRequest, WorkItemRun } from "../types";

export async function enqueueWorkItemRun(
  request: EnqueueWorkItemRunRequest
): Promise<WorkItemRun> {
  return invoke<WorkItemRun>("project_enqueue_work_item_run", { request });
}

export async function listWorkItemRuns({
  projectSlug,
  orgId,
  shortId,
  limit = 50,
}: {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId: string;
  limit?: number;
}): Promise<WorkItemRun[]> {
  return invoke<WorkItemRun[]>("project_list_work_item_runs", {
    projectSlug: projectSlug ?? null,
    orgId: orgId ?? null,
    shortId,
    limit,
  });
}

export async function retryLatestWorkItemRun({
  projectSlug,
  orgId,
  shortId,
  sessionId,
  idempotencyKey,
}: {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId: string;
  sessionId: string;
  idempotencyKey: string;
}): Promise<WorkItemRun> {
  return invoke<WorkItemRun>("project_retry_latest_work_item_run", {
    projectSlug: projectSlug ?? null,
    orgId: orgId ?? null,
    shortId,
    sessionId,
    idempotencyKey,
  });
}
