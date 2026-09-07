import { z } from "zod/v4";

import { ActivityChunkSchema } from "@src/api/realtime/websocket/schemas";

export const CliMessageRequestSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
  turnIntentId: z.string().min(1),
  clientMessageId: z.string().min(1),
  model: z.string().optional(),
  accountId: z.string().optional(),
  ideContext: z.unknown().optional(),
  mode: z.string().optional(),
  images: z.array(z.string()).optional(),
  allowNativeContextRecovery: z.boolean().optional(),
});

/** `cli_agent_message` takes a single `request` struct, like the other
 * multi-field commands (`benchmark_*`, `human_session_*`, pagination). */
export const CliMessageInputSchema = z.object({
  request: CliMessageRequestSchema,
});

export const CliRunReceiptSchema = z.object({
  sessionId: z.string(),
  turnIntentId: z.string(),
  status: z.string(),
});

export const CliSessionIdInputSchema = z.object({
  sessionId: z.string().min(1),
});

export const CliCancelInputSchema = CliSessionIdInputSchema.extend({
  reason: z.string().optional(),
});

export const CliStatusSchema = z
  .object({
    sessionId: z.string(),
    status: z.string(),
    updatedAt: z.string(),
    errorMessage: z.string().nullable().optional(),
    totalTokens: z.number().optional(),
    transcriptSource: z.string().optional(),
  })
  .passthrough();

export const CliStatusBatchInputSchema = z.object({
  sessionIds: z.array(z.string().min(1)).max(256),
});

export const CliStatusBatchItemSchema = z.object({
  sessionId: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  turnIntentId: z.string().optional(),
});

export const CliChunksSchema = z.array(ActivityChunkSchema);

export const CliTranscriptRevisionSchema = z.object({
  native: z.boolean(),
  revision: z.string().nullable().optional(),
});
