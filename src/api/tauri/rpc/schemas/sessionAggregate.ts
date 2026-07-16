/**
 * Session Aggregate RPC Schemas
 *
 * Zod schemas for session_aggregate_list / session_get_aggregate_stats commands.
 * Rust source: src-tauri/src/agent_sessions/unified_stats/
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
 * Wire category from Rust (cli | agent | os).
 * Transformed at parse time to `DispatchCategory` so consumers never see the
 * wire value — only the routing value used by the frontend.
 */
const WireCategorySchema = z
  .enum(["cli", "agent", "os"])
  .transform((cat): "cli_agent" | "rust_agent" => {
    if (cat === "cli") return "cli_agent";
    return "rust_agent";
  });

// Schema for wire validation only — canonical KeySource type lives in dispatchTypes.ts
const KeySourceSchema = z.enum(["own_key", "hosted_key"]);

// ── Filter input ──

export const SessionFilterInput = z.object({
  category: z.string().optional(),
  status: z.string().optional(),
  keySource: z.string().optional(),
  repoPath: z.string().optional(),
  orgId: z.string().optional(),
  projectSlug: z.string().optional(),
  workItemId: z.string().optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
  textQuery: z.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
  includeExternalHistory: z.boolean().optional(),
  includeStats: z.boolean().optional(),
  externalHistorySource: z.string().optional(),
  activeOnly: z.boolean().optional(),
});

export const SessionAggregateListInput = z.object({
  filter: SessionFilterInput.optional(),
});

export const SessionGetAggregateStatsInput = z.object({
  sessionIds: z.array(z.string()).optional(),
  keySource: z.string().optional(),
});

export const SessionUsageSummaryInput = z.object({
  sessionId: z.string().min(1),
});

export const SessionHeatmapMetricSchema = z.enum([
  "sessions",
  "tokens",
  "cost",
]);

export const SessionHeatmapInput = z.object({
  filter: z
    .object({
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      metric: SessionHeatmapMetricSchema.optional(),
      category: z.string().optional(),
      keySource: z.string().optional(),
      timezoneOffsetMinutes: z.number().int().optional(),
    })
    .optional(),
});

/**
 * Input for `session_patch`.
 *
 * Mutation API for in-session field edits. Mirrors the Rust
 * `SessionPatch` struct one-to-one — see
 * `src-tauri/src/agent_sessions/unified_stats/patch.rs` for the
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
  // Channel origin for OS Agent sessions (e.g. "feishu", "telegram").
  channel: z.string().optional(),
});

export const CategoryStatsSchema = z
  .object({
    cli: z.number().int(),
    agent: z.number().int(),
    os: z.number().int().optional(),
  })
  .transform((raw) => ({
    cliAgent: raw.cli,
    rustAgent: raw.agent + (raw.os ?? 0),
  }));

export const KeySourceStatsSchema = z.object({
  ownKey: z.number().int(),
  hostedKey: z.number().int(),
});

export const SessionStatsSchema = z.object({
  total: z.number().int(),
  active: z.number().int(),
  completed: z.number().int(),
  failed: z.number().int(),
  byCategory: CategoryStatsSchema,
  byKeySource: KeySourceStatsSchema,
});

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionAggregateRecordSchema),
  stats: SessionStatsSchema.optional(),
});

export const AggregateStatsSchema = z.object({
  totalCostUsd: z.number(),
  totalTokensInput: z.number().int(),
  totalTokensOutput: z.number().int(),
  totalTokens: z.number().int(),
  ongoingCount: z.number().int(),
  completedCount: z.number().int(),
  failedCount: z.number().int(),
});

export const SessionUsageSummarySchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  totalTokens: z.number().int(),
  contextTokens: z.number().int(),
  costUsd: z.number(),
});

export const SessionHeatmapCellSchema = z.object({
  day: z.number().int(),
  date: z.string(),
  label: z.string(),
  hour: z.number().int(),
  count: z.number().int(),
  tokens: z.number().int(),
  cost: z.number(),
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      name: z.string(),
      userInput: z.string().optional(),
      cliAgentType: CliAgentTypeSchema.optional(),
      agentIconId: z.string().optional(),
    })
  ),
});

export const SessionHeatmapResponseSchema = z.object({
  cells: z.array(SessionHeatmapCellSchema),
  maxCount: z.number().int(),
  maxTokens: z.number().int(),
  maxCost: z.number(),
  totalSessions: z.number().int(),
  totalTokens: z.number().int(),
  totalCost: z.number(),
});

export type SessionFilter = z.input<typeof SessionFilterInput>;
export type SessionAggregateRecord = z.output<
  typeof SessionAggregateRecordSchema
>;
export type SessionListResponse = z.output<typeof SessionListResponseSchema>;
export type AggregateStats = z.output<typeof AggregateStatsSchema>;
export type SessionUsageSummary = z.output<typeof SessionUsageSummarySchema>;
export type SessionHeatmapMetric = z.output<typeof SessionHeatmapMetricSchema>;
export type SessionHeatmapFilter = z.input<
  typeof SessionHeatmapInput
>["filter"];
export type SessionHeatmapResponse = z.output<
  typeof SessionHeatmapResponseSchema
>;
export type SessionPatchPayload = z.input<typeof SessionPatchInput>;
