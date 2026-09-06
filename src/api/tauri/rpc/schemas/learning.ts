/**
 * Learning RPC Schemas
 *
 * Zod schemas for L3 learnings Tauri commands.
 * Rust source: src-tauri/src/agent_core/intelligence/memory/commands.rs
 */
import { z } from "zod/v4";

// ── Input schemas ──

export const TriggerReflectionInput = z.object({
  sessionId: z.string(),
});

export const ListLearningsInput = z.object({
  agentScope: z.string().optional(),
});

export const DeprecateLearningInput = z.object({
  learningId: z.string(),
});

// Learnings Browser

export const LearningStatusEnum = z.enum([
  "pending",
  "active",
  "merged",
  "deprecated",
  "abandoned",
]);
export type LearningStatusValue = z.output<typeof LearningStatusEnum>;

export const SettableLearningStatusEnum = z.enum([
  "pending",
  "active",
  "merged",
  "deprecated",
]);
export type SettableLearningStatusValue = z.output<
  typeof SettableLearningStatusEnum
>;

export const LearningSourceEnum = z.enum([
  "reflection",
  "pattern_extraction",
  "active_observation",
]);
export type LearningSourceValue = z.output<typeof LearningSourceEnum>;

export const LearningCategoryEnum = z.enum([
  "pattern",
  "correction",
  "preference",
  "strategy",
]);
export type LearningCategoryValue = z.output<typeof LearningCategoryEnum>;

export const LearningsListInput = z.object({
  agentScope: z.string().optional(),
  status: LearningStatusEnum.optional(),
  source: LearningSourceEnum.optional(),
  category: LearningCategoryEnum.optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const LearningsUpdateBodyInput = z.object({
  learningId: z.string(),
  takeaway: z.string().optional(),
  content: z.string().min(1),
});

export const LearningsSetStatusInput = z.object({
  learningId: z.string(),
  next: SettableLearningStatusEnum,
});

export const LearningsDeleteInput = z.object({
  learningId: z.string(),
});

export const LearningsGetStatusInput = z.object({
  agentScope: z.string().optional(),
});

// ── Output schemas ──

// Rust LearningRecord has no serde rename_all, so fields arrive as snake_case.
export const LearningRecordSchema = z.object({
  id: z.string(),
  content: z.string(),
  takeaway: z.string().nullable(),
  category: z.string(),
  importance: z.number(),
  confidence: z.number(),
  status: LearningStatusEnum,
  source: z.string(),
  reinforcement_count: z.number().int(),
  content_hash: z.string().nullable(),
  account_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  agent_scope: z.string(),
  last_recalled_at: z.string().nullable(),
  parent_id: z.string().nullable(),
});

export const ReflectionResultSchema = z.object({
  learnings_stored: z.number().int(),
  session_id: z.string(),
});

export const ConsolidationRunSummarySchema = z.object({
  trigger: z.string(),
  mode: z.string(),
  pending_input: z.number().int(),
  added: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
  none_count: z.number().int(),
  abandoned: z.number().int(),
  reinforced: z.number().int(),
  error: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});

export const LearningsStatusReportSchema = z.object({
  agent_scope: z.string(),
  pending_count: z.number().int(),
  active_count: z.number().int(),
  merged_count: z.number().int(),
  deprecated_count: z.number().int(),
  abandoned_count: z.number().int(),
  last_run: ConsolidationRunSummarySchema.nullable(),
  next_trigger_hint: z.string(),
});

export type LearningRecord = z.output<typeof LearningRecordSchema>;

export type LearningsStatusReport = z.output<
  typeof LearningsStatusReportSchema
>;
