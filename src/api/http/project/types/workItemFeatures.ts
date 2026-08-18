import type { CommentEntry } from "./common";
import type { WorkItemRun } from "./workRuns";

export interface WorkItemScope {
  projectSlug?: string | null;
  orgId: string;
  workItemId: string;
}

export type WorkItemMentionTarget =
  | { kind: "member"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "agent_org"; id: string }
  | { kind: "all" };

export interface DiscussionPostRequest extends WorkItemScope {
  commentId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentionedUserIds?: string[];
  mentions?: WorkItemMentionTarget[];
  parentId?: string | null;
  targetSessionId?: string | null;
}

export interface DiscussionPostResult {
  comment: CommentEntry;
  run?: WorkItemRun | null;
  threadReopened: boolean;
  wakeReason: "discussion_reply" | "note_only" | "no_linked_session" | string;
}

export interface DiscussionTriggerPreview {
  willWake: boolean;
  reason: string;
  targetSessionId?: string | null;
  targetKind?: "resume" | "start" | null;
  willCoalesce?: boolean;
}

export type SubscriptionReason =
  | "creator"
  | "assignee"
  | "commenter"
  | "mentioned"
  | "manual"
  | "agent"
  | "delegated";

export interface WorkItemSubscription {
  subscriberId: string;
  reason: SubscriptionReason;
  createdAt: string;
  mutedAt?: string | null;
}

export type PropertyType =
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "url";

export interface PropertyOption {
  id: string;
  name: string;
  color?: string | null;
}

export interface PropertyConfig {
  options: PropertyOption[];
}

export interface PropertyDefinition {
  id: string;
  orgId: string;
  name: string;
  propertyType: PropertyType;
  description?: string | null;
  config: PropertyConfig;
  position: number;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPropertyDefinitionRequest {
  id?: string | null;
  orgId: string;
  name: string;
  propertyType: PropertyType;
  description?: string | null;
  config?: PropertyConfig;
  position?: number;
}

export interface WorkItemPropertyValue {
  definition: PropertyDefinition;
  value: unknown;
  updatedAt: string;
}

export interface PrReadiness {
  state:
    | "missing"
    | "blocked"
    | "merged_blocked"
    | "ready_to_complete"
    | string;
  prUrl?: string | null;
  prStatus?: string | null;
  isDraft: boolean;
  mergeable?: boolean | null;
  ciStatus?: string | null;
  failedChecks: string[];
  otherOpenPrs: string[];
  snapshotStale: boolean;
  closeIntent: boolean;
  canComplete: boolean;
  blockers: string[];
  evidenceAt: string;
}

export interface RoutineWebhookInstallInfo {
  routineName: string;
  urlPath: string;
  secret: string;
  secretHint: string;
  rotatedAt: string;
}

export interface RoutineWebhookStatus {
  routineName: string;
  installed: boolean;
  enabled: boolean;
  secretHint?: string | null;
  consecutiveFailures: number;
  pausedAt?: string | null;
}

export interface RoutineWebhookDelivery {
  id: string;
  routineName: string;
  provider: string;
  eventKind: string;
  idempotencyKey: string;
  status: string;
  reason?: string | null;
  routineRunId?: string | null;
  createdAt: string;
  updatedAt: string;
}
