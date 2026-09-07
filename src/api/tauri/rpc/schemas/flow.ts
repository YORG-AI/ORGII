/**
 * Zod schemas for flow awareness Tauri commands.
 *
 * Rust: `agent_core/foundation/flow_awareness/commands.rs`
 * ActivityInput and FlowSummaryOutput use `#[serde(rename_all = "camelCase")]`.
 * Activity uses `#[serde(rename = "type")]` for the activity type tag → field `type` on wire.
 */
import { z } from "zod/v4";

export const ActivityInputSchema = z.object({
  type: z.string(),
  sessionId: z.string().optional(),
  path: z.string().optional(),
  editType: z.string().optional(),
  linesChanged: z.number().int().nonnegative().optional(),
  command: z.string().optional(),
  workingDir: z.string().optional(),
  exitCode: z.number().int().optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  resultCount: z.number().int().nonnegative().optional(),
  operation: z.string().optional(),
  contentPreview: z.string().optional(),
  sourceFile: z.string().optional(),
  gitOp: z.string().optional(),
  details: z.string().optional(),
  target: z.string().optional(),
  errorType: z.string().optional(),
  message: z.string().optional(),
  line: z.number().int().nonnegative().optional(),
  action: z.string().optional(),
});

export const FlowRecordActivitiesInput = z.object({
  activities: z.array(ActivityInputSchema),
});

export const FlowGetContextInput = z.object({
  sessionId: z.string().optional(),
  maxActivities: z.number().int().positive().optional(),
});

export const FlowGetSummaryInput = z.object({
  sessionId: z.string().optional(),
  maxActivities: z.number().int().positive().optional(),
});

export const FlowClearSessionInput = z.object({
  sessionId: z.string(),
});

export const FlowSummaryOutputSchema = z.object({
  intent: z.string().nullable().optional(),
  recentEdits: z.array(z.string()),
  recentOpens: z.array(z.string()),
  recentCommands: z.array(z.string()),
  recentSearches: z.array(z.string()),
  currentErrors: z.array(z.string()),
  idleSeconds: z.number().int().nonnegative().nullable().optional(),
});
