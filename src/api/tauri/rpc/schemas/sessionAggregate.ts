/**
 * Session Aggregate RPC Schemas
 *
 * Zod schemas for session_aggregate_list / session_get_aggregate_stats commands.
 * Rust source: src-tauri/src/agent_sessions/session_directory/
 *
 * All Rust structs use #[serde(rename_all = "camelCase")], so field names
 * arrive as camelCase — no transform needed.
 */
import { z } from "zod/v4";

import {
  CliAgentTypeSchema,
  MergeStatusSchema,
  PriceTierSchema,
} from "./validation";

// ── Enums ──

/**
 * Wire category from Rust (cli | agent | os | human).
 * Transformed at parse time to `DispatchCategory` so consumers never see the
 * wire value — only the routing value used by the frontend.
 */
const WireCategorySchema = z
  .enum(["cli", "agent", "os", "human"])
  .transform((cat): "cli_agent" | "rust_agent" | "human_session" => {
    if (cat === "cli") return "cli_agent";
    if (cat === "human") return "human_session";
    return "rust_agent";
  });

// Schema for wire validation only — canonical KeySource type lives in dispatchTypes.ts
const KeySourceSchema = z.enum(["own_key", "hosted_key"]);

// ── Filter input ──

export const SessionFilterInput = z.object({
  sessionIds: z.array(z.string().min(1)).optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  keySource: z.string().optional(),
  repoPath: z.string().optional(),
  repoPathExact: z.boolean().optional(),
  missingRepoPath: z.boolean().optional(),
  orgId: z.string().optional(),
  orgIds: z.array(z.string().min(1)).min(1).optional(),
  projectSlug: z.string().optional(),
  workItemId: z.string().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
  beforeUpdatedAt: z.string().min(1).optional(),
  beforeSessionId: z.string().min(1).optional(),
  textQuery: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  includeExternalHistory: z.boolean().optional(),
  externalHistorySource: z.string().optional(),
  disabledExternalHistorySources: z.array(z.string()).optional(),
  updatedAfterMs: z.number().int().optional(),
  updatedBeforeMs: z.number().int().optional(),
  activeOnly: z.boolean().optional(),
  pinnedOnly: z.boolean().optional(),
});

export const SessionAggregateListInput = z.object({
  filter: SessionFilterInput.optional(),
});

export const ExternalHistorySidebarDateBucketSchema = z.enum([
  "today",
  "yesterday",
  "thisWeek",
  "older",
]);

export const ExternalHistorySidebarCursorSchema = z.object({
  updatedAtMs: z.number().int(),
  sessionId: z.string().min(1),
});

export const ExternalHistorySidebarSourceRequestSchema = z
  .object({
    source: z.string().min(1),
    repoPath: z.string().min(1).optional(),
    missingRepoPath: z.boolean().optional(),
    buckets: z
      .array(
        z
          .object({
            bucket: ExternalHistorySidebarDateBucketSchema,
            startMs: z.number().int().optional(),
            endMs: z.number().int().optional(),
            limit: z.number().int().min(1).max(50),
            offset: z.number().int().min(0),
            before: ExternalHistorySidebarCursorSchema.optional(),
          })
          .refine(
            ({ startMs, endMs }) =>
              startMs === undefined || endMs === undefined || startMs < endMs,
            { message: "startMs must precede endMs" }
          )
      )
      .refine(
        (buckets) =>
          new Set(buckets.map(({ bucket }) => bucket)).size === buckets.length,
        { message: "date buckets must be unique" }
      ),
  })
  .refine(
    ({ repoPath, missingRepoPath }) =>
      repoPath === undefined || missingRepoPath !== true,
    { message: "repoPath and missingRepoPath are mutually exclusive" }
  );

export const ExternalHistorySidebarListInput = z.object({
  requests: z
    .array(ExternalHistorySidebarSourceRequestSchema)
    .min(1)
    .refine(
      (requests) =>
        new Set(requests.map(({ source }) => source)).size === requests.length,
      { message: "external history sources must be unique" }
    ),
});

/**
 * Input for `session_patch`.
 *
 * Mutation API for in-session field edits. Mirrors the Rust
 * `SessionPatch` struct one-to-one — see
 * `src-tauri/src/agent_sessions/session_directory/patch.rs` for the
 * routing rules.
 *
 * Allowed fields are deliberately limited:
 *  - `name` — session display title, including generated Rust-agent titles.
 *  - `model` + optional `accountId` — atomic model+key swap (one user pick).
 *  - `agentExecMode` — ModePill click; legal for Rust-agent and CLI-agent sessions.
 *  - `draftText` (P3) — per-session unsent composer text. `null` = clear,
 *    string = set. Field absent = leave alone.
 *  - `replyTargetEventId` (P3) — per-session reply pin. Same three-state
 *    semantics as `draftText`.
 *
 * Three-state semantics (`draftText` / `replyTargetEventId`):
 *   field absent      → leave column alone
 *   field === null    → clear column to NULL (composer cleared / reply dismissed)
 *   field === string  → write that value
 * Mirrors the Rust `Option<Option<String>>` double-Option deserialize.
 *
 * Fields that are NOT mutable here on purpose (set at session create):
 *  - `keySource` (mis-billing risk if changed mid-session)
 *  - `cliAgentType` (CLI process already spawned)
 *  - `listingModel` (piggybacks on `model` for market sessions)
 */
export const SessionPatchInput = z.object({
  sessionId: z.string().min(1),
  patch: z
    .object({
      name: z.string().trim().min(1).optional(),
      model: z.string().optional(),
      accountId: z.string().optional(),
      agentExecMode: z.string().optional(),
      // `.nullable().optional()` is the zod equivalent of the Rust
      // `Option<Option<String>>`: undefined = leave alone, null = clear,
      // string = set.
      draftText: z.string().nullable().optional(),
      replyTargetEventId: z.string().nullable().optional(),
      // Pin toggle (absent = leave alone)
      pinned: z.boolean().optional(),
    })
    .refine(
      (p) =>
        p.name !== undefined ||
        p.model !== undefined ||
        p.agentExecMode !== undefined ||
        p.draftText !== undefined ||
        p.replyTargetEventId !== undefined ||
        p.pinned !== undefined,
      { message: "session_patch: at least one field must be set" }
    )
    .refine((p) => !(p.accountId !== undefined && p.model === undefined), {
      message:
        "session_patch: accountId provided without model — pair them in the same call",
    }),
});

// ── Output schemas ──

export const SessionAggregateRecordSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  category: WireCategorySchema,
  externalHistorySource: z.string().optional(),
  userInput: z.string().optional(),
  repoPath: z.string().optional(),
  repoRootPath: z.string().optional(),
  repoRemoteUrls: z.array(z.string()).optional(),
  storagePath: z.string().optional(),
  repoName: z.string().optional(),
  branch: z.string().optional(),
  model: z.string().optional(),
  accountId: z.string().optional(),
  cliAgentType: CliAgentTypeSchema.optional(),
  keySource: KeySourceSchema,
  tier: PriceTierSchema.optional(),
  pid: z.number().int().nullable().optional(),
  totalTokens: z.number().int(),
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  baseBranch: z.string().optional(),
  mergeStatus: MergeStatusSchema.optional(),
  background: z.boolean(),
  orgId: z.string().optional(),
  projectId: z.string().optional(),
  projectName: z.string().optional(),
  projectSlug: z.string().optional(),
  workItemId: z.string().optional(),
  agentRole: z.string().optional(),
  isActive: z.boolean(),
  displayLabel: z.string().optional(),
  parentSessionId: z.string().optional(),
  orgMemberId: z.string().optional(),
  agentOrgId: z.string().optional(),
  agentOrgName: z.string().optional(),
  agentDefinitionId: z.string().optional(),
  agentIconId: z.string().optional(),
  agentDisplayName: z.string().optional(),
  // Per-session exec mode picked via in-session ModePill. Undefined means
  // "user has never patched this session" — frontend falls back to
  // `creatorDefaultExecModeAtom` until the first `session_patch`. CLI
  // sessions always emit `undefined` (no mode concept). String (not
  // strict enum) so the wire format tolerates new modes added on the
  // Rust side without a coordinated frontend release.
  agentExecMode: z.string().optional(),
  // Per-session unsent draft text (P3). The chat composer mirrors this
  // into ComposerInput on session activation. Cleared on send. Persisted via
  // debounced `session_patch` calls — see `useSessionDraftField`.
  draftText: z.string().optional(),
  // Per-session reply target event id (P3). Set when the user clicks
  // "Reply" on a chat item; cleared when the banner is dismissed or the
  // message is sent. Persisted via `session_patch`.
  replyTargetEventId: z.string().optional(),
  // Whether the session is pinned to the top of the sidebar.
  pinned: z.boolean().default(false),
  filesChanged: z.number().int().optional(),
  linesAdded: z.number().int().optional(),
  linesRemoved: z.number().int().optional(),
  touchedFiles: z.array(z.string()).optional(),
});

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionAggregateRecordSchema),
});

export const ExternalHistorySidebarRowSchema = z.object({
  sessionId: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Live status decoration (hook-derived or transcript-recency fallback).
  // Absent means the historical default: a terminal, read-only "completed".
  status: z.string().optional(),
  isActive: z.boolean().optional(),
  repoPath: z.string().optional(),
  repoRootPath: z.string().optional(),
  repoRemoteUrls: z.array(z.string()).optional(),
  // The source app's transcript file. Imported sessions have no sessions.db
  // copy, so this is their only storage path.
  storagePath: z.string().optional(),
  model: z.string().optional(),
  totalTokens: z.number().int().optional(),
  filesChanged: z.number().int().optional(),
  linesAdded: z.number().int().optional(),
  linesRemoved: z.number().int().optional(),
  touchedFiles: z.array(z.string()).optional(),
});

export const ExternalHistorySidebarResponseSchema = z.object({
  source: z.string(),
  buckets: z.array(
    z.object({
      bucket: ExternalHistorySidebarDateBucketSchema,
      sessions: z.array(ExternalHistorySidebarRowSchema),
      hasMore: z.boolean(),
      nextCursor: ExternalHistorySidebarCursorSchema.optional(),
    })
  ),
});

export const ExternalHistorySidebarBatchResponseSchema = z.object({
  sources: z.array(ExternalHistorySidebarResponseSchema),
});

export const SessionWorkspaceFacetListInput = z.object({
  request: z.object({
    orgIds: z.array(z.string().min(1)).min(1),
    includeExternalHistory: z.boolean().optional(),
    disabledExternalHistorySources: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(50),
    offset: z.number().int().min(0).optional(),
    before: z
      .object({
        lastUpdatedAtMs: z.number().int(),
        repoPath: z.string().nullable(),
      })
      .optional(),
  }),
});

export const SessionWorkspaceFacetResponseSchema = z.object({
  facets: z.array(
    z.object({
      repoPath: z.string().nullable().optional(),
      lastUpdatedAtMs: z.number().int(),
      sessionCount: z.number().int().min(0),
    })
  ),
  hasMore: z.boolean(),
});

export type SessionFilter = z.input<typeof SessionFilterInput>;
export type SessionAggregateRecord = z.output<
  typeof SessionAggregateRecordSchema
>;
export type SessionListResponse = z.output<typeof SessionListResponseSchema>;
export type ExternalHistorySidebarDateBucket = z.output<
  typeof ExternalHistorySidebarDateBucketSchema
>;
export type ExternalHistorySidebarCursor = z.output<
  typeof ExternalHistorySidebarCursorSchema
>;
export type ExternalHistorySidebarListRequest = z.input<
  typeof ExternalHistorySidebarListInput
>;
export type ExternalHistorySidebarSourceRequest = z.input<
  typeof ExternalHistorySidebarSourceRequestSchema
>;
export type ExternalHistorySidebarResponse = z.output<
  typeof ExternalHistorySidebarResponseSchema
>;
export type ExternalHistorySidebarBatchResponse = z.output<
  typeof ExternalHistorySidebarBatchResponseSchema
>;
export type SessionWorkspaceFacetListRequest = z.input<
  typeof SessionWorkspaceFacetListInput
>["request"];
export type SessionWorkspaceFacetResponse = z.output<
  typeof SessionWorkspaceFacetResponseSchema
>;
export type SessionPatchPayload = z.input<typeof SessionPatchInput>;
