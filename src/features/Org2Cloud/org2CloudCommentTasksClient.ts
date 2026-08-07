/**
 * Managed-cloud comment agent-task client (migration 0002, design
 * session-comments-agent-pickup-design-0707 §3/§4).
 *
 * Typed throwing wrappers for the nine `org2_cloud` comment-task RPCs, in
 * the `org2CloudCommentsClient` idiom (raw fetch, JWT Bearer +
 * `Content-Profile: org2_cloud`, whole-token `ORG2_*` code extraction).
 * All nine are MEMBER tier — tasks are members-only, matching comments v1.
 *
 * Protocol highlights (0002):
 * - `leaseToken` is the per-claim FENCING credential: `claimCommentTask`
 *   is the ONLY wrapper that surfaces it (invariant 1) — no listing or
 *   embedded task payload ever carries it, structurally (the zod wire
 *   schemas strip unknown keys). Hold it in runner scope; it must never
 *   reach atoms or anything reachable from render code.
 * - `ORG2_CONFLICT` is deliberately overloaded and the CALL SITE
 *   disambiguates: on claim it means "someone else holds a live lease /
 *   attempt cap"; on start/heartbeat/complete it means "you lost the
 *   lease — stop all coordination writes".
 * - The attempt cap raises `ORG2_CONFLICT`, NEVER `ORG2_QUOTA_EXCEEDED`:
 *   the sync engine's `isBackoffError` reads quota as ORG-LEVEL backoff
 *   and list/claim are engine-reachable. Quota exists only on create (a
 *   human-affordance RPC — the org-wide 200-live-task cap).
 * - `progress`/`result` are opaque jsonb — the server enforces only
 *   serialized size bounds (4000/8000 chars), so they are typed `unknown`
 *   here on purpose; do not invent a schema the server does not enforce.
 * - `releaseCommentTask` with a stale token is a fenced no-op `{ok:true}`;
 *   `completeCommentTask` is terminally idempotent (a re-fire with the
 *   same token returns `{ok:true}` without a second report).
 */
import { z } from "zod/v4";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";

// ---------------------------------------------------------------------------
// Protocol constants (server-side counterparts noted; changing one here
// never changes the wire protocol — the server clamps/enforces)
// ---------------------------------------------------------------------------

/** Default claim lease. The server clamps `p_lease_seconds` to 60..3600. */
export const CLOUD_TASK_LEASE_SECONDS = 900;

/** Runner heartbeat cadence — 1/15th of the lease, generous fencing slack. */
export const CLOUD_TASK_HEARTBEAT_MS = 60_000;

/** RPC-enforced serialized-progress bound (task-row jsonb, NEVER comments). */
export const CLOUD_TASK_PROGRESS_MAX_CHARS = 4000;

/**
 * Hard claim cap enforced inside the claim predicate (crash-loop
 * token-burn breaker). At cap the claim raises `ORG2_CONFLICT` — the
 * row's `attempt` lets the UI explain and offer the privileged reset.
 */
export const CLOUD_TASK_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

// ZERO new codes (0002 regime): every entry already exists in the deployed
// error vocabulary. ORG2_QUOTA_EXCEEDED appears ONLY on create.
export const ORG2_TASK_ERROR_CODES = [
  "ORG2_VALIDATION",
  "ORG2_NOT_FOUND",
  "ORG2_SESSION_NOT_FOUND",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_RETENTION_EXPIRED",
  "ORG2_FORBIDDEN",
  "ORG2_QUOTA_EXCEEDED",
  "ORG2_CONFLICT",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
] as const;

export type Org2TaskErrorCode = (typeof ORG2_TASK_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudTaskError extends Error {
  readonly code: Org2TaskErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudTaskError";
    this.status = status;
    // Whole-token match (org2CloudOrgManagement precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_TASK_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2TaskErrorCode | undefined) ?? null;
  }
}

export function isOrg2TaskErrorCode(
  error: unknown,
  code: Org2TaskErrorCode
): boolean {
  return error instanceof Org2CloudTaskError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing; JWT bearer — members only)
// ---------------------------------------------------------------------------

async function callTaskRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const endpoint = getCloudEndpoint();
  const response = await fetch(
    `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: {
        apikey: endpoint.anonKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify(body),
    }
  );
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `org2_cloud rpc ${functionName} failed with ${response.status}`;
    throw new Org2CloudTaskError(message, response.status);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Wire shapes (comment_task_wire — the ONE task shape every RPC builds)
// ---------------------------------------------------------------------------

/** Server FSM: open → claimed → running → done|failed (+ reopen → open). */
export const CloudCommentTaskStateSchema = z.enum([
  "open",
  "claimed",
  "running",
  "done",
  "failed",
]);

export type CloudCommentTaskState = z.output<
  typeof CloudCommentTaskStateSchema
>;

// Trailing .optional() keeps the inferred keys optional (`forkSessionId?:`)
// — the protocol.ts idiom — so plain object literals stay assignable.
// Exported: the 0002 `cloud_list_session_comments` embed returns the same
// `comment_task_wire` rows, so the comments client parses this schema too.
export const CloudCommentTaskWireSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  commentId: z.string(),
  state: CloudCommentTaskStateSchema,
  /**
   * Computed lazily server-side, matching the claim predicate exactly: a
   * claimed/running row with a NULL lease_expires_at reads as NOT expired
   * (fail-closed — never advertised as stealable).
   */
  leaseExpired: z.boolean(),
  // claimed_by/created_by are GDPR-nullable (resolved_by precedent) — a
  // null id with a kept row means "an erased user", never a dropped task.
  claimedByUserId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  // profiles LEFT JOIN — a missing profile yields null, never a dropped row.
  claimedByDisplayName: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  createdByUserId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Lifetime claim count; cap = CLOUD_TASK_MAX_ATTEMPTS, reset-only. */
  attempt: z.number(),
  /** The runner's forked local session id, set by start; cleared on claim. */
  forkSessionId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  instruction: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Opaque jsonb (server bounds serialized SIZE only) — do not schema it. */
  progress: z
    .unknown()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Opaque jsonb; `result.errorKind` is mirrored into `errorCode`. */
  result: z
    .unknown()
    .transform((value) => value ?? undefined)
    .optional(),
  errorCode: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CloudCommentTask = z.output<typeof CloudCommentTaskWireSchema>;

// Structural mirror of the comments list-entry wire (add/list parity rule)
// plus the 0002 `kind` discriminator — `agent_report` here is stamped by
// the complete RPC's definer-internal insert, so it is unspoofable. Kept
// local so the complete wrapper parses independently of the comments
// schema's own 0002 migration; the OUTPUT stays assignable to
// `CloudSessionComment` either way (`kind` is additive-optional).
const CloudReportCommentWireSchema = z.object({
  id: z.string(),
  eventId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  parentId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  authorUserId: z.string(),
  authorDisplayName: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  body: z.string(),
  createdAt: z.string(),
  editedAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  deletedAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  resolvedAt: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Absent on pre-0002 backends ⇒ 'user' semantics. */
  kind: z
    .enum(["user", "agent_report"])
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
});

type CloudReportComment = z.output<typeof CloudReportCommentWireSchema>;

const CreateTaskResultSchema = z.object({
  task: CloudCommentTaskWireSchema,
  created: z.boolean(),
});

// The ONLY schema in this module that carries leaseToken (invariant 1).
const ClaimTaskResultSchema = z.object({
  task: CloudCommentTaskWireSchema,
  leaseToken: z.string(),
  attempt: z.number(),
  leaseExpiresAt: z.string(),
});

const LeaseRenewalResultSchema = z.object({
  ok: z.boolean(),
  leaseExpiresAt: z.string(),
});

const CompleteTaskResultSchema = z.object({
  ok: z.boolean(),
  reportComment: CloudReportCommentWireSchema.nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  reportSkipped: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
});

const ReleaseTaskResultSchema = z.object({
  ok: z.boolean(),
});

const ListTasksResultSchema = z.object({
  serverTime: z.string(),
  tasks: z.array(CloudCommentTaskWireSchema).default([]),
});

// ---------------------------------------------------------------------------
// The seven wrappers
// ---------------------------------------------------------------------------

export interface CreateCommentTaskInput {
  orgId: string;
  /** A TOP-LEVEL comment (thread head) of a readable session. */
  commentId: string;
  /** Optional extra brief for the runner, 1..4000 chars (RPC-enforced). */
  instruction?: string;
}

export interface CreateCommentTaskResult {
  task: CloudCommentTask;
  /** false = the idempotent fast path returned the pre-existing task. */
  created: boolean;
}

/**
 * Promote a top-level thread to a task. Any member who can read the
 * session (same bar as commenting). IDEMPOTENT per comment (UNIQUE
 * comment_id): a re-create returns the existing task with `created:false`
 * from a fast path that runs BEFORE the org-wide 200-live-task cap, so a
 * retry can never be rejected by quota.
 */
export async function createCommentTask(
  accessToken: string,
  input: CreateCommentTaskInput
): Promise<CreateCommentTaskResult> {
  const payload = await callTaskRpc("cloud_create_comment_task", accessToken, {
    p_org_id: input.orgId,
    p_comment_id: input.commentId,
    p_instruction: input.instruction ?? null,
  });
  return CreateTaskResultSchema.parse(payload);
}

export interface ClaimCommentTaskResult {
  task: CloudCommentTask;
  /**
   * THE fencing credential — this envelope is the only place it ever
   * appears. Keep it in runner scope for the start/heartbeat/complete/
   * release fence; never store it in atoms or anything reachable from
   * render code.
   */
  leaseToken: string;
  /** Post-increment claim count (cap = CLOUD_TASK_MAX_ATTEMPTS). */
  attempt: number;
  leaseExpiresAt: string;
}

/**
 * Claim for execution: open, or claimed/running with an EXPIRED lease
 * (lazy expiry, no cron — a steal bumps `attempt` and mints a fresh
 * token, fencing the stale holder out of every subsequent write).
 * `ORG2_CONFLICT` = a live holder OR the attempt cap (the row's `attempt`
 * disambiguates — NO holder identity in the error).
 * `ORG2_RETENTION_EXPIRED` = the session aged out of the caller's replay
 * window (billing-upgrade deep-link path).
 */
export async function claimCommentTask(
  accessToken: string,
  orgId: string,
  taskId: string,
  leaseSeconds: number = CLOUD_TASK_LEASE_SECONDS
): Promise<ClaimCommentTaskResult> {
  const payload = await callTaskRpc("cloud_claim_comment_task", accessToken, {
    p_org_id: orgId,
    p_task_id: taskId,
    p_lease_seconds: leaseSeconds,
  });
  return ClaimTaskResultSchema.parse(payload);
}

export interface CommentTaskLeaseRenewal {
  ok: boolean;
  leaseExpiresAt: string;
}

/**
 * claimed → running; records the fork session id and renews the lease
 * (never shortening a longer claim-time lease). Token-fenced:
 * `ORG2_CONFLICT` = lease lost, stop coordination writes. Idempotent
 * re-call with the SAME fork id (safe if the client crashes between start
 * and the first send).
 */
export async function startCommentTask(
  accessToken: string,
  orgId: string,
  taskId: string,
  leaseToken: string,
  forkSessionId: string
): Promise<CommentTaskLeaseRenewal> {
  const payload = await callTaskRpc("cloud_start_comment_task", accessToken, {
    p_org_id: orgId,
    p_task_id: taskId,
    p_lease_token: leaseToken,
    p_fork_session_id: forkSessionId,
  });
  return LeaseRenewalResultSchema.parse(payload);
}

export interface HeartbeatCommentTaskInput {
  orgId: string;
  taskId: string;
  leaseToken: string;
  /**
   * Bounded opaque progress (≤ CLOUD_TASK_PROGRESS_MAX_CHARS serialized)
   * stored ON THE TASK ROW — progress never writes comment rows. Omitted
   * = renew the lease without overwriting the stored progress.
   */
  progress?: unknown;
  /** Server-clamped 60..3600; defaults to CLOUD_TASK_LEASE_SECONDS. */
  leaseSeconds?: number;
}

/**
 * Token-fenced lease renewal on the CLOUD_TASK_HEARTBEAT_MS cadence.
 * `ORG2_CONFLICT` = lease lost — stop all coordination writes silently;
 * the local fork continues as a normal session.
 */
export async function heartbeatCommentTask(
  accessToken: string,
  input: HeartbeatCommentTaskInput
): Promise<CommentTaskLeaseRenewal> {
  const payload = await callTaskRpc(
    "cloud_heartbeat_comment_task",
    accessToken,
    {
      p_org_id: input.orgId,
      p_task_id: input.taskId,
      p_lease_token: input.leaseToken,
      p_progress: input.progress ?? null,
      p_lease_seconds: input.leaseSeconds ?? CLOUD_TASK_LEASE_SECONDS,
    }
  );
  return LeaseRenewalResultSchema.parse(payload);
}

export interface CompleteCommentTaskInput {
  orgId: string;
  taskId: string;
  leaseToken: string;
  ok: boolean;
  /**
   * Structured outcome (≤8000 chars serialized); on failure the server
   * mirrors `result.errorKind` into the row's `errorCode`.
   */
  result: unknown;
  /**
   * 1..4000 chars. When present the server inserts ONE reply with
   * `kind='agent_report'` — the only writer of that kind (unspoofable).
   */
  reportBody?: string;
}

export interface CompleteCommentTaskResult {
  ok: boolean;
  /**
   * The inserted agent report in the exact list-entry wire shape —
   * insert into the comments atom without a refetch. Absent on
   * terminal-idempotent re-fires and when the report was skipped.
   */
  reportComment?: CloudReportComment;
  /**
   * 'quota' (500-comment cap) | 'thread_deleted' — the task STILL
   * completed (invariant 6); permissive string for additive reasons.
   */
  reportSkipped?: string;
}

/**
 * Terminal transition (done/failed) + at most ONE agent-attributed report
 * reply per attempt. Token-fenced and terminally IDEMPOTENT: a re-fire
 * with the same token returns `{ok:true}` without a second report. Never
 * touches resolution — that stays human-only via the existing resolve RPC.
 */
export async function completeCommentTask(
  accessToken: string,
  input: CompleteCommentTaskInput
): Promise<CompleteCommentTaskResult> {
  const payload = await callTaskRpc(
    "cloud_complete_comment_task",
    accessToken,
    {
      p_org_id: input.orgId,
      p_task_id: input.taskId,
      p_lease_token: input.leaseToken,
      p_ok: input.ok,
      p_result: input.result ?? null,
      p_report_body: input.reportBody ?? null,
    }
  );
  return CompleteTaskResultSchema.parse(payload);
}

/**
 * Voluntary release back to open (`attempt` NOT refunded — the cap counts
 * claims, not outcomes). A stale/superseded token is a fenced NO-OP
 * `{ok:true}`: it must never free a task now held by someone else, nor
 * reopen a terminal row.
 */
export async function releaseCommentTask(
  accessToken: string,
  orgId: string,
  taskId: string,
  leaseToken: string
): Promise<{ ok: boolean }> {
  const payload = await callTaskRpc("cloud_release_comment_task", accessToken, {
    p_org_id: orgId,
    p_task_id: taskId,
    p_lease_token: leaseToken,
  });
  return ReleaseTaskResultSchema.parse(payload);
}

export interface ListCommentTasksResult {
  serverTime: string;
  tasks: CloudCommentTask[];
}

/**
 * The engine's 60s delta pull. Visibility mirrors the session-listing
 * predicate byte-for-byte (member + non-deleted + retention window +
 * restricted = owner-or-directed-grant, NO admin bypass) — a task is
 * never visible when its session is not. NEVER returns a lease token
 * (structural: comment_task_wire). `since` is the persisted ISO cursor
 * (serverTime − overlap); null = full listing (once per engine start).
 */
export async function listCommentTasks(
  accessToken: string,
  orgId: string,
  since: string | null
): Promise<ListCommentTasksResult> {
  const payload = await callTaskRpc("cloud_list_comment_tasks", accessToken, {
    p_org_id: orgId,
    p_since: since,
  });
  return ListTasksResultSchema.parse(payload);
}
