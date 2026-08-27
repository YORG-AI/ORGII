/**
 * Work item discussion threads, subscriptions and PR readiness.
 */
import { invoke } from "@tauri-apps/api/core";

import { invalidateCache } from "../cache";
import type {
  DiscussionPostRequest,
  DiscussionPostResult,
  DiscussionTriggerPreview,
  PrReadiness,
  WorkItemMentionTarget,
  WorkItemScope,
  WorkItemSubscription,
} from "../types";

export async function previewDiscussionTrigger(
  request: WorkItemScope & {
    content: string;
    mentions?: WorkItemMentionTarget[];
    parentId?: string | null;
    targetSessionId?: string | null;
  }
): Promise<DiscussionTriggerPreview> {
  return invoke("project_discussion_preview_trigger", { request });
}

export async function postDiscussionComment(
  request: DiscussionPostRequest
): Promise<DiscussionPostResult> {
  const result = await invoke<DiscussionPostResult>(
    "project_discussion_post_comment",
    { request }
  );
  invalidateCache();
  return result;
}

export async function resolveDiscussionThread(input: {
  scope: WorkItemScope;
  threadId: string;
  actorId: string;
  conclusionCommentId?: string | null;
}): Promise<import("../types").CommentEntry[]> {
  const { scope, ...mutation } = input;
  const result = await invoke<import("../types").CommentEntry[]>(
    "project_discussion_resolve_thread",
    { request: { ...scope, ...mutation } }
  );
  invalidateCache();
  return result;
}

export async function reopenDiscussionThread(input: {
  scope: WorkItemScope;
  threadId: string;
  actorId: string;
}): Promise<import("../types").CommentEntry[]> {
  const { scope, ...mutation } = input;
  const result = await invoke<import("../types").CommentEntry[]>(
    "project_discussion_reopen_thread",
    { request: { ...scope, ...mutation, conclusionCommentId: null } }
  );
  invalidateCache();
  return result;
}

export async function listWorkItemSubscriptions(
  scope: WorkItemScope
): Promise<WorkItemSubscription[]> {
  return invoke("project_list_work_item_subscriptions", { scope });
}

export async function setWorkItemSubscribed(
  scope: WorkItemScope,
  subscriberId: string,
  subscribed: boolean
): Promise<WorkItemSubscription[]> {
  return invoke(
    subscribed
      ? "project_subscribe_work_item"
      : "project_unsubscribe_work_item",
    { request: { ...scope, subscriberId } }
  );
}

export async function getWorkItemPrReadiness(
  scope: WorkItemScope
): Promise<PrReadiness> {
  return invoke("project_get_work_item_pr_readiness", { scope });
}
