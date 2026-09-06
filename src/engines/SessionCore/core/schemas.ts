import { z } from "zod/v4";

import { JsonRecordFromAnySchema } from "@src/util/schemas/jsonRecord";

const UnknownRecordSchema = z.record(z.string(), z.unknown());

export const RawSessionEventSchema = z
  .object({
    type: z.string(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    payload: UnknownRecordSchema.optional(),
  })
  .catchall(z.unknown());

export const EventDisplayStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "pending",
  "awaiting_user",
]);

export const EventDisplayVariantSchema = z.enum([
  "tool_call",
  "message",
  "thinking",
  "plan",
  "approval",
  "session",
  "summary",
  "error",
]);

export const ActivityStatusSchema = z.enum(["agent", "pending", "processed"]);

const ExtractedDataSchema = z.unknown();

export const SessionEventSchema = z
  .object({
    chunk_id: z.string().nullable(),
    id: z.string(),
    sessionId: z.string(),
    createdAt: z.string(),
    functionName: z.string(),
    uiCanonical: z.string(),
    actionType: z.string(),
    args: UnknownRecordSchema,
    result: JsonRecordFromAnySchema,
    source: z.enum(["assistant", "user", "system"]),
    displayText: z.string(),
    displayStatus: EventDisplayStatusSchema,
    displayVariant: EventDisplayVariantSchema,
    activityStatus: ActivityStatusSchema,
    threadId: z.string().optional(),
    processId: z.string().optional(),
    callId: z.string().optional(),
    filePath: z.string().optional(),
    command: z.string().optional(),
    isDelta: z.boolean().optional(),
    repoId: z.string().optional(),
    repoPath: z.string().optional(),
    shellPid: z.number().optional(),
    shellProcessStatus: z
      .enum(["running", "background", "exited", "killed"])
      .optional(),
    shellExitCode: z.number().optional(),
    shellLogPath: z.string().optional(),
    extracted: ExtractedDataSchema.optional(),
  })
  .catchall(z.unknown());

export const SessionSpecSchema = z.object({
  specId: z.string(),
  sessionId: z.string(),
  spec: z.string(),
  content: z.string().optional(),
  createdTime: z.string(),
  status: z.string().optional(),
  stepId: z.string().nullable().optional(),
});

export const SessionSpecArraySchema = z.array(SessionSpecSchema);
export const SessionEventArraySchema = z.array(SessionEventSchema);
export const JsonRecordSchema = UnknownRecordSchema;
export const JsonStringArraySchema = z.array(z.string());

export type ParsedRawSessionEvent = z.output<typeof RawSessionEventSchema>;

export type ParsedSessionSpec = z.output<typeof SessionSpecSchema>;

export function parseRawSessionEvent(raw: string): ParsedRawSessionEvent {
  return RawSessionEventSchema.parse(JSON.parse(raw));
}

export function parseJsonRecord(raw: string): Record<string, unknown> {
  return JsonRecordSchema.parse(JSON.parse(raw));
}

export function parseJsonStringArray(raw: string): string[] {
  return JsonStringArraySchema.parse(JSON.parse(raw));
}

export function parseSessionSpecsJson(raw: string): ParsedSessionSpec[] {
  return SessionSpecArraySchema.parse(JSON.parse(raw));
}
