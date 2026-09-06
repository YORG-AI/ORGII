import { invoke } from "@tauri-apps/api/core";

export const TOOL_USAGE_ATTRIBUTION_METHOD = {
  PROVIDER_EXACT: "provider_exact",
  SINGLE_TOOL_ITERATION: "single_tool_iteration",
  SPLIT_BY_SERIALIZED_SIZE: "split_by_serialized_size",
  SPLIT_EVENLY: "split_evenly",
  ESTIMATED_TOKENIZER: "estimated_tokenizer",
  BYTES_ONLY: "bytes_only",
} as const;

export type ToolUsageAttributionMethod =
  (typeof TOOL_USAGE_ATTRIBUTION_METHOD)[keyof typeof TOOL_USAGE_ATTRIBUTION_METHOD];

export interface LlmUsageSpanRecord {
  id: number;
  sessionId: string;
  turnId: string;
  iterationIndex: number;
  model?: string | null;
  accountId?: string | null;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens: number;
  relatedToolCallIdsJson?: string | null;
  contextUsageJson?: string | null;
  createdAt: string;
}

export interface ToolUsageAttributionRecord {
  id: number;
  sessionId: string;
  turnId: string;
  eventId: string;
  toolCallId: string;
  toolName: string;
  iterationIndex: number;
  decisionCompletionTokens: number;
  resultContextTokens: number;
  followupCompletionTokens: number;
  inputBytes: number;
  outputBytes: number;
  attributionMethod: ToolUsageAttributionMethod;
  createdAt: string;
}

export async function getSessionLlmUsageSpans(
  sessionId: string,
  turnId?: string
): Promise<LlmUsageSpanRecord[]> {
  return invoke("get_session_llm_usage_spans", {
    sessionId,
    turnId: turnId ?? null,
  });
}

export async function getSessionToolUsageAttributions(
  sessionId: string,
  turnId?: string
): Promise<ToolUsageAttributionRecord[]> {
  return invoke("get_session_tool_usage_attributions", {
    sessionId,
    turnId: turnId ?? null,
  });
}
