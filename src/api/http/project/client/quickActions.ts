/**
 * Org-scoped Quick Actions: saved mention-comment templates that wake the
 * discussion route on a work item.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type {
  DiscussionPostResult,
  QuickAction,
  UpsertQuickActionRequest,
} from "../types";

export function quickActionsCacheKey(orgId: string): string {
  return `${orgId}:quick-actions`;
}

export async function listQuickActions(orgId: string): Promise<QuickAction[]> {
  return cachedRead(quickActionsCacheKey(orgId), () =>
    invoke("project_list_quick_actions", { orgId })
  );
}

export async function upsertQuickAction(
  request: UpsertQuickActionRequest
): Promise<QuickAction> {
  const result = await invoke<QuickAction>("project_upsert_quick_action", {
    request,
  });
  invalidateCache(request.orgId);
  return result;
}

export async function archiveQuickAction(
  orgId: string,
  id: string
): Promise<QuickAction> {
  const result = await invoke<QuickAction>("project_archive_quick_action", {
    orgId,
    id,
  });
  invalidateCache(orgId);
  return result;
}

export async function invokeQuickAction(input: {
  projectSlug: string | null;
  orgId: string;
  workItemId: string;
  actionId: string;
  actorId: string;
  actorName: string;
}): Promise<DiscussionPostResult> {
  const result = await invoke<DiscussionPostResult>(
    "project_invoke_quick_action",
    { request: input }
  );
  invalidateCache();
  return result;
}
