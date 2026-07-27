import { z } from "zod/v4";

export const HUMAN_SESSION_TITLE_MAX_LENGTH = 80;

export const HumanSessionEntrySchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const HumanSessionSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  workspacePath: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  entries: z.array(HumanSessionEntrySchema),
});

export const HumanSessionCreateInput = z.object({
  request: z.object({
    body: z.string().trim().min(1).max(100_000),
    title: z.string().trim().max(HUMAN_SESSION_TITLE_MAX_LENGTH).optional(),
    workspacePath: z.string().nullable().optional(),
  }),
});

export const HumanSessionGetInput = z.object({ sessionId: z.string().min(1) });

export const HumanSessionAppendInput = z.object({
  request: z.object({
    sessionId: z.string().min(1),
    body: z.string().trim().min(1).max(100_000),
  }),
});

export type HumanSessionEntry = z.infer<typeof HumanSessionEntrySchema>;
export type HumanSession = z.infer<typeof HumanSessionSchema>;
