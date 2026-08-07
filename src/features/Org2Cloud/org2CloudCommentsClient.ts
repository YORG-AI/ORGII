/**
 * Managed-cloud session comments client (migration 0014, design
 * session-comments-design-0707 §4).
 *
 * Typed throwing wrappers for the five `org2_cloud` comment RPCs, in the
 * `org2CloudSharesClient` idiom (raw fetch, JWT Bearer + `Content-Profile:
 * org2_cloud`, whole-token `ORG2_*` code extraction). All five are MEMBER
 * tier — comments are members-only in v1 (no guest/ticket surface).
 *
 * Wire contract highlights (0014):
 * - `cloud_add_session_comment` returns `{comment: {…}}` in the SAME shape
 *   as a `cloud_list_session_comments` entry, so the client inserts it
 *   without a refetch.
 * - Replies inherit the parent's anchor: sending BOTH eventId and parentId
 *   is a contradictory anchor and fails closed server-side — the wrapper
 *   never builds that request.
 * - Tombstones ride the list with an EMPTY body + `deletedAt` (thread shape
 *   preserved; the client renders "comment deleted").
 *
 * 0002 (comment agent tasks, design session-comments-agent-pickup-design-0707
 * §3/§4) additive extensions, parsed tolerantly so pre-0002 backends keep
 * working:
 * - Every comment carries `kind` ('user' | 'agent_report'); absent on
 *   pre-0002 ⇒ undefined ⇒ 'user' semantics. The add RPC accepts
 *   `agent_report` only from the session owner; task completion also stamps
 *   reports server-side.
 * - `cloud_list_session_comments` also returns a top-level `tasks` array
 *   (`comment_task_wire` rows for THIS session — schema imported from
 *   org2CloudCommentTasksClient so the two clients cannot drift); absent on
 *   pre-0002 ⇒ []. It NEVER carries a lease token (invariant 1) — the claim
 *   response is the only carrier.
 */
import { z } from "zod/v4";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import {
  type CloudCommentTask,
  CloudCommentTaskWireSchema,
} from "./org2CloudCommentTasksClient";

/** RPC-enforced body bound (0014 SIZE note) — mirrored in composers. */
export const CLOUD_COMMENT_MAX_BODY_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export const ORG2_COMMENT_ERROR_CODES = [
  "ORG2_VALIDATION",
  "ORG2_NOT_FOUND",
  "ORG2_SESSION_NOT_FOUND",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_RETENTION_EXPIRED",
  "ORG2_FORBIDDEN",
  "ORG2_REPLAY_NOT_AVAILABLE",
  "ORG2_QUOTA_EXCEEDED",
  "ORG2_AUTH_REQUIRED",
  "ORG2_MEMBER_REQUIRED",
] as const;

export type Org2CommentErrorCode = (typeof ORG2_COMMENT_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class Org2CloudCommentError extends Error {
  readonly code: Org2CommentErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudCommentError";
    this.status = status;
    // Whole-token match (org2CloudOrgManagement precedent): a longer future
    // code that textually contains a listed one must never be mis-mapped.
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_COMMENT_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2CommentErrorCode | undefined) ?? null;
  }
}

export function isOrg2CommentErrorCode(
  error: unknown,
  code: Org2CommentErrorCode
): boolean {
  return error instanceof Org2CloudCommentError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing; JWT bearer — members only)
// ---------------------------------------------------------------------------

async function callCommentRpc(
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
    throw new Org2CloudCommentError(message, response.status);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

// Trailing .optional() keeps the inferred keys optional (`eventId?:`) — the
// protocol.ts idiom — so plain object literals stay assignable.
const CloudSessionCommentWireSchema = z.object({
  id: z.string(),
  /** Anchor event id; absent/null = session-level note. */
  eventId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Set on replies (flat threads: parents are always top-level). */
  parentId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  authorUserId: z.string(),
  // profiles LEFT JOIN — a missing profile yields null, never a dropped row.
  authorDisplayName: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Empty string on tombstones (server re-masks at read time). */
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
  resolution: z
    .enum(["resolved", "wont_fix"])
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /**
   * 0002 discriminator; absent on pre-0002 backends ⇒ undefined ⇒ 'user'
   * semantics. The server restricts `agent_report` writes to the session
   * owner (and stamps task-completion reports internally).
   */
  kind: z
    .enum(["user", "agent_report"])
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
});

export type CloudSessionComment = z.output<
  typeof CloudSessionCommentWireSchema
>;

const AddCommentResultSchema = z.object({
  comment: CloudSessionCommentWireSchema,
});

const ListCommentsResultSchema = z.object({
  comments: z.array(CloudSessionCommentWireSchema).default([]),
  // 0002 embed: this session's `comment_task_wire` rows (structurally no
  // lease_token — zod strips unknown keys anyway). Absent on pre-0002
  // backends — default to [] so callers never branch on backend age.
  tasks: z.array(CloudCommentTaskWireSchema).default([]),
});

const EditCommentResultSchema = z.object({
  editedAt: z.string(),
});

// ---------------------------------------------------------------------------
// The five wrappers
// ---------------------------------------------------------------------------

export interface AddSessionCommentInput {
  orgId: string;
  sessionId: string;
  body: string;
  /**
   * Turn anchor (requires the session's `access_mode = 'full_replay'`).
   * Mutually exclusive with `parentId` — replies inherit the parent's
   * anchor and the server rejects the contradictory pair.
   */
  eventId?: string;
  /** Reply target: an existing TOP-LEVEL comment of the same session. */
  parentId?: string;
  /** 'agent_report' is accepted by the server only from the session owner. */
  kind?: "agent_report";
}

/**
 * Any member who can read the session. Returns the created comment in the
 * listing wire shape, ready for optimistic insertion.
 */
export async function addSessionComment(
  accessToken: string,
  input: AddSessionCommentInput
): Promise<CloudSessionComment> {
  const body: Record<string, unknown> = {
    p_org_id: input.orgId,
    p_session_id: input.sessionId,
    p_body: input.body,
    p_event_id: input.eventId ?? null,
    p_parent_id: input.parentId ?? null,
  };
  // `p_kind` was added after the base comments migration. Omit it for normal
  // user comments so clients remain compatible with pre-extension backends;
  // only the additive agent-report path requires the newer argument.
  if (input.kind) body.p_kind = input.kind;
  const payload = await callCommentRpc(
    "cloud_add_session_comment",
    accessToken,
    body
  );
  return AddCommentResultSchema.parse(payload).comment;
}

/** Author only; tombstones are not editable. Returns the new `editedAt`. */
export async function editSessionComment(
  accessToken: string,
  orgId: string,
  commentId: string,
  body: string
): Promise<string> {
  const payload = await callCommentRpc(
    "cloud_edit_session_comment",
    accessToken,
    {
      p_org_id: orgId,
      p_comment_id: commentId,
      p_body: body,
    }
  );
  return EditCommentResultSchema.parse(payload).editedAt;
}

/** Author OR org admin/owner: idempotent soft delete (body blanked). */
export async function deleteSessionComment(
  accessToken: string,
  orgId: string,
  commentId: string
): Promise<void> {
  await callCommentRpc("cloud_delete_session_comment", accessToken, {
    p_org_id: orgId,
    p_comment_id: commentId,
  });
}

export type CloudCommentResolution = "resolved" | "wont_fix";

/**
 * Top-level only; thread author OR session owner OR org admin. Idempotent
 * both ways (`resolved` sets, `!resolved` clears). Resolution stays
 * HUMAN-only — the task complete RPC never touches it.
 */
export async function resolveSessionComment(
  accessToken: string,
  orgId: string,
  commentId: string,
  resolved: boolean,
  resolution?: CloudCommentResolution
): Promise<void> {
  const base = {
    p_org_id: orgId,
    p_comment_id: commentId,
    p_resolved: resolved,
  };
  if (resolved && resolution === "wont_fix") {
    try {
      await callCommentRpc("cloud_resolve_session_comment", accessToken, {
        ...base,
        p_resolution: resolution,
      });
      return;
    } catch (error) {
      if (!(error instanceof Org2CloudCommentError) || error.status !== 404) {
        throw error;
      }
    }
  }
  await callCommentRpc("cloud_resolve_session_comment", accessToken, base);
}

export interface SessionCommentsListing {
  comments: CloudSessionComment[];
  /**
   * This session's agent tasks (0002 `comment_task_wire` embed,
   * `created_at` asc; one per thread head — UNIQUE comment_id). [] on
   * pre-0002 backends. NEVER carries a lease token — the claim response
   * is the only carrier.
   */
  tasks: CloudCommentTask[];
}

/**
 * Full thread list for one readable session, `created_at` asc (no
 * pagination — the 500-row cap bounds the response). Tombstones included.
 * 0002 embeds the session's task rows in the SAME fetch, so thread UIs get
 * task state riding the existing 30s TTL machinery without a second RPC.
 */
export async function listSessionComments(
  accessToken: string,
  orgId: string,
  sessionId: string
): Promise<SessionCommentsListing> {
  const payload = await callCommentRpc(
    "cloud_list_session_comments",
    accessToken,
    {
      p_org_id: orgId,
      p_session_id: sessionId,
    }
  );
  return ListCommentsResultSchema.parse(payload);
}
