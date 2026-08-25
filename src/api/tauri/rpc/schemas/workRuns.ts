import { z } from "zod/v4";

export const ConversationTurnAcceptInput = z.object({
  runId: z.string(),
  claimToken: z.string(),
  accepted: z.boolean(),
  reason: z.string().optional(),
});

export const ConversationTurnReleaseInput = z.object({
  runId: z.string(),
  claimToken: z.string(),
});

export const ConversationTurnNackInput = z.object({
  runId: z.string(),
  claimToken: z.string(),
  reason: z.string(),
});

export const ConversationTurnPrepareRunnerInput = z.object({
  runId: z.string(),
  claimToken: z.string(),
  rootSessionId: z.string(),
  runnerSessionId: z.string(),
});

export const ConversationTurnAckRunnerInput = z.object({
  runId: z.string(),
  claimToken: z.string(),
  rootSessionId: z.string(),
  runnerSessionId: z.string(),
});
