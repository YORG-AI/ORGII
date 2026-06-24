/**
 * Zod schemas for the ZenMux quota monitoring commands.
 */
import { z } from "zod/v4";

// ── Output: quota_get_zenmux_status ──────────────────────────────────────

export const ZenmuxQuotaStatusSchema = z
  .object({
    quota5hPct: z.number(),
    quota7dPct: z.number(),
    resets5h: z.string().nullable().optional(),
    resets7d: z.string().nullable().optional(),
  })
  .nullable();

export type ZenmuxQuotaStatus = z.output<typeof ZenmuxQuotaStatusSchema>;

// ── Input / Output: session_get_context_status ───────────────────────────

export const SessionContextStatusInput = z.object({
  sessionId: z.string(),
});

export const SessionContextStatusSchema = z.object({
  roundCount: z.number().int(),
  totalTokens: z.number().int(),
});

export type SessionContextStatus = z.output<typeof SessionContextStatusSchema>;
