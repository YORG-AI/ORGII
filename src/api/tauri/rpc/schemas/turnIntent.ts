import { z } from "zod/v4";

export const TurnIntentStatusSchema = z.enum([
  "optimistic",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stale",
  "coalesced",
  "rejected",
]);

export const TurnIntentStatusInputSchema = z.object({
  sessionId: z.string().min(1),
  turnIntentId: z.string().min(1),
});

export const TurnIntentStatusReceiptSchema = z.object({
  status: TurnIntentStatusSchema,
  effectiveTurnIntentId: z.string().min(1),
});
