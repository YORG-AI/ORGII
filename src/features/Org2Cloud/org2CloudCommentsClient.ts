/**
 * Managed-cloud session comments client (canonical design:
 * docs/architecture/managed-cloud-collaboration.md).
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
 * Every comment carries `kind` ('user' | 'agent_report'); absent on an older
 * backend means ordinary user semantics. Only the cloud-session owner's
 * authenticated client may stamp `agent_report` after its local model round.
 */
import { z } from "zod/v4";

import { ORG2_CLOUD_POSTGREST_SCHEMA, getCloudEndpoint } from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";

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
  const response = await fetchWithTransportRetry(
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
   * Agent-reply discriminator; absent on an older backend means `user`.
   * The server accepts `agent_report` only from the cloud-session owner.
   */
  kind: z
    .enum(["user", "agent_report"])
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
  /** Explicit user ids targeted by the comment (0010 Team Inbox). */
  mentionedUserIds: z.array(z.string()).max(50).optional(),
});

export type CloudSessionComment = z.output<
  typeof CloudSessionCommentWireSchema
>;

const AddCommentResultSchema = z.object({
  comment: CloudSessionCommentWireSchema,
});

const ListCommentsResultSchema = z.object({
  comments: z.array(CloudSessionCommentWireSchema).default([]),
  /** Viewer-derived server capability; false for imports, forks and members. */
  viewerOwnsSession: z.boolean().default(false),
  /** 0004 delta anchor; absent on pre-delta backends. */
  serverTime: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined)
    .optional(),
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
  /** 'agent_report' — accepted only from the cloud-session owner. */
  kind?: "agent_report";
  /**
   * Explicit active org-member ids to notify. Display names are never parsed
   * server-side because they are mutable and may not be unique.
   */
  mentionedUserIds?: string[];
  /**
   * Local session the comment ORIGINATED from (the fork the author is
   * viewing). Stored server-side for per-fork count attribution; omitted /
   * null keeps the comment counted on the source plane.
   */
  originSessionId?: string | null;
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
  // `p_origin_session_id` was added after the base comments migration (same
  // pre-extension-compat rule as p_kind). Only forks/imports set it — a
  // source-plane comment omits it and coalesces to the source at count time.
  if (input.originSessionId) body.p_origin_session_id = input.originSessionId;
  const mentionedUserIds = [
    ...new Set(input.mentionedUserIds?.filter(Boolean) ?? []),
  ];
  if (mentionedUserIds.length > 50) {
    throw new Org2CloudCommentError("ORG2_VALIDATION");
  }
  if (mentionedUserIds.length > 0) {
    body.p_mentioned_user_ids = mentionedUserIds;
  }
  let payload: unknown;
  try {
    payload = await callCommentRpc(
      mentionedUserIds.length > 0
        ? "cloud_add_session_comment_with_mentions"
        : "cloud_add_session_comment",
      accessToken,
      body
    );
  } catch (error) {
    // Graceful degradation to a pre-origin backend: PostgREST answers 404
    // when no function matches the argument set, so drop the additive origin
    // arg and retry once. The comment still posts (counted on the source
    // plane); per-fork attribution just waits for the migration.
    if (
      "p_origin_session_id" in body &&
      mentionedUserIds.length === 0 &&
      error instanceof Org2CloudCommentError &&
      error.status === 404
    ) {
      delete body.p_origin_session_id;
      payload = await callCommentRpc(
        "cloud_add_session_comment",
        accessToken,
        body
      );
    } else {
      throw error;
    }
  }
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
 * HUMAN-only — agent replies never change it implicitly.
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
  viewerOwnsSession: boolean;
  /** 0004 delta anchor for the caller's next `since`; absent pre-delta. */
  serverTime?: string;
  /** The `since` the server actually honored; undefined ⇒ full listing. */
  appliedSince?: string;
}

/** supabaseUrl set of backends that rejected the p_since signature (pre-0004). */
const commentsDeltaUnsupportedEndpoints = new Set<string>();

function isCommentsDeltaSignatureUnsupported(error: unknown): boolean {
  return (
    error instanceof Org2CloudCommentError &&
    error.status === 404 &&
    /could not find the function/i.test(error.message)
  );
}

export const __SESSION_COMMENTS_DELTA_INTERNALS = {
  resetDeltaSupport: () => commentsDeltaUnsupportedEndpoints.clear(),
};

/**
 * Thread list for one readable session, `created_at` asc (no pagination —
 * the 500-row cap bounds the response). Tombstones included. With
 * `options.since` a 0004 backend returns only rows stamped at or past it
 * (`appliedSince` echoes the honored cursor); a pre-0004 backend rejects the
 * signature once per endpoint and every listing degrades to full. Callers
 * MUST treat `appliedSince === undefined` as a full listing regardless of
 * what they requested.
 */
export async function listSessionComments(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: { since?: string }
): Promise<SessionCommentsListing> {
  const endpointUrl = getCloudEndpoint().supabaseUrl;
  const since =
    options?.since !== undefined &&
    !commentsDeltaUnsupportedEndpoints.has(endpointUrl)
      ? options.since
      : undefined;
  if (since !== undefined) {
    try {
      const payload = await callCommentRpc(
        "cloud_list_session_comments",
        accessToken,
        {
          p_org_id: orgId,
          p_session_id: sessionId,
          p_since: since,
        }
      );
      return {
        ...ListCommentsResultSchema.parse(payload),
        appliedSince: since,
      };
    } catch (error) {
      if (!isCommentsDeltaSignatureUnsupported(error)) throw error;
      commentsDeltaUnsupportedEndpoints.add(endpointUrl);
    }
  }
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
