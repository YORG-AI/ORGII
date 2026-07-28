/**
 * Props Normalizer — UI RENDERING LAYER
 *
 * Final transformation step: input props → UniversalEventProps.
 * Prepares data for React component rendering.
 *
 * INPUT FORMATS HANDLED:
 * - Chat Panel: { event: SessionEvent } (direct, zero-conversion)
 * - Simulator: { ...flat fields, mode }
 * - Trajectory: { event, isSelected, onSelect }
 *
 * OUTPUT: UniversalEventProps with:
 * - Normalized status (running/success/failed/pending)
 * - Render context (chat/simulator/trajectory)
 * - Event variant (tool_call/message/thinking)
 * - Animation config
 */
import { useMemo } from "react";

import {
  LLM_USAGE_ARGS_KEY,
  type LlmUsageMetadata,
  type SessionEvent,
  TOOL_USAGE_ARGS_KEY,
  type ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import type {
  AnimationConfig,
  EventStatus,
  EventVariant,
  RenderContext,
  UniversalEventProps,
} from "@src/engines/SessionCore/rendering/types/universalProps";
import { normalizeActivity } from "@src/lib/activityData";

const ACTIVE_EVENT_PAINTING_TTL_MS = 30 * 60 * 1000;

function readToolUsageMetadata(
  args: Record<string, unknown>,
  eventToolUsage?: ToolUsageMetadata
): ToolUsageMetadata | undefined {
  if (eventToolUsage) return eventToolUsage;
  const raw = args[TOOL_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ToolUsageMetadata;
}

function readLlmUsageMetadata(
  args: Record<string, unknown>,
  eventLlmUsage?: LlmUsageMetadata
): LlmUsageMetadata | undefined {
  if (eventLlmUsage) return eventLlmUsage;
  const raw = args[LLM_USAGE_ARGS_KEY];
  if (!raw || typeof raw !== "object") return undefined;
  return raw as LlmUsageMetadata;
}

function shouldShowActiveEventPainting(
  status: EventStatus,
  createdAt?: string
): boolean {
  if (status !== "running" && status !== "pending") return false;
  if (!createdAt) return true;
  const createdAtMs = new Date(createdAt).getTime();
  if (Number.isNaN(createdAtMs)) return true;
  return Date.now() - createdAtMs <= ACTIVE_EVENT_PAINTING_TTL_MS;
}

// ============================================
// Input Types
// ============================================

/** Raw input props from any context */
export interface RawEventInput {
  // Chat format — SessionEvent passed directly (no snake_case conversion)
  event?: SessionEvent;

  // Simulator/Trajectory format
  event_id?: string;
  function?: string;
  action_type?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  created_time?: string;
  status?: string | string[];

  // Context hints
  mode?: string;
  context?: RenderContext;
  variant?: EventVariant;

  // Interaction
  isSelected?: boolean;
  onSelect?: () => void;

  // Animation
  enableTypewriter?: boolean;
  typewriterConfig?: AnimationConfig["typewriterConfig"];
  enableAutoScroll?: boolean;
  autoScrollConfig?: AnimationConfig["autoScrollConfig"];
  autoScrollLoop?: boolean;

  // Streaming
  streamingContent?: string;
  isStreaming?: boolean;
  itemIndex?: number;

  // Allow any additional props
  [key: string]: unknown;
}

// ============================================
// Status Mapping
// ============================================

/**
 * Normalize an arbitrary status string/array into the canonical `EventStatus`.
 *
 * Exported so simulator / trajectory layers can reproduce the exact same
 * status mapping the chat panel uses, keeping their lifecycle labels in
 * sync (see `CodePanel/index.tsx#ExploreHeader`).
 */
export function mapStatus(rawStatus: unknown): EventStatus {
  if (!rawStatus) return "running";

  const statusStr =
    typeof rawStatus === "string"
      ? rawStatus
      : Array.isArray(rawStatus)
        ? rawStatus[rawStatus.length - 1]
        : String(rawStatus);

  const normalized = statusStr.toLowerCase();

  if (
    normalized.includes("success") ||
    normalized.includes("completed") ||
    normalized.includes("verified")
  ) {
    return "success";
  }
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized.includes("pending") || normalized.includes("waiting")) {
    return "pending";
  }
  if (normalized.includes("cancel")) {
    return "cancelled";
  }
  return "running";
}

/**
 * Infer a status string from result shape when no explicit status is set.
 * Returns undefined when no signal is found (mapStatus will default to "running").
 *
 * Exported alongside `mapStatus` so non-chat surfaces (simulator, trajectory)
 * can derive lifecycle state from `SessionEvent.displayStatus` + `result`
 * the same way the chat panel does.
 */
export function inferStatusFromResult(
  result: Record<string, unknown>
): string | undefined {
  if (result?.status && typeof result.status === "string") return result.status;
  if (result?.success === true) return "success";
  if (result?.success === false) return "failed";
  if (result?.error || result?.error_message) return "failed";
  if (result && Object.keys(result).length > 0) return "success";
  return undefined;
}

// ============================================
// Context & Variant Detection
// ============================================

function detectContext(input: RawEventInput): RenderContext {
  if (input.context) return input.context;
  if (input.event) return "chat";
  if (input.onSelect !== undefined) return "trajectory";
  return "simulator";
}

function detectVariant(context: RenderContext): EventVariant {
  // Chat uses chat styling, simulator and trajectory use simulator styling
  return context === "chat" ? "chat" : "simulator";
}

// ============================================
// Main Normalizer
// ============================================

/**
 * Normalize any input format to UniversalEventProps.
 *
 * Fast path: when `input.event` (SessionEvent) is present, reads typed fields
 * directly — no normalizeActivity() round-trip.
 *
 * Slow path: simulator/trajectory format goes through normalizeActivity().
 */
export function normalizeEventProps(
  input: RawEventInput,
  eventType: string
): UniversalEventProps | null {
  if (!input) return null;

  const context = detectContext(input);
  const variant = input.variant || detectVariant(context);

  // Build animation config (shared by both paths)
  const animation: AnimationConfig | undefined =
    input.enableTypewriter || input.enableAutoScroll
      ? {
          enableTypewriter: input.enableTypewriter,
          typewriterConfig: input.typewriterConfig,
          enableAutoScroll: input.enableAutoScroll,
          autoScrollConfig: input.autoScrollConfig,
          autoScrollLoop: input.autoScrollLoop,
        }
      : undefined;

  // Fast path: SessionEvent passed directly (chat panel)
  const sessionEvent = input.event;
  if (sessionEvent) {
    const args = sessionEvent.args ?? {};
    const result = sessionEvent.result ?? {};
    const status = mapStatus(
      sessionEvent.displayStatus || inferStatusFromResult(result)
    );
    const toolUsage = readToolUsageMetadata(args, sessionEvent.toolUsage);
    const llmUsage = readLlmUsageMetadata(args, sessionEvent.llmUsage);
    return {
      eventId: sessionEvent.id,
      eventType,
      functionName: sessionEvent.functionName,
      callId: sessionEvent.callId,
      toolUsage,
      llmUsage,
      filePath: sessionEvent.filePath,
      repoPath: sessionEvent.repoPath,
      sessionId: sessionEvent.sessionId,
      args,
      result,
      status,
      timestamp: sessionEvent.createdAt,
      showActiveEventPainting: shouldShowActiveEventPainting(
        status,
        sessionEvent.createdAt
      ),
      shellPid: sessionEvent.shellPid,
      shellProcessStatus: sessionEvent.shellProcessStatus,
      shellExitCode: sessionEvent.shellExitCode,
      shellLogPath: sessionEvent.shellLogPath,
      shellReplay: sessionEvent.shellReplay,
      variant,
      context,
      isSelected: input.isSelected,
      onSelect: input.onSelect,
      animation,
      itemIndex: input.itemIndex,
      streamingContent: input.streamingContent,
      isStreaming: input.isStreaming,
      rustExtracted: sessionEvent.extracted,
      payloadRefs: sessionEvent.payloadRefs,
    };
  }

  // Slow path: simulator/trajectory format (flat props)
  const normalized = normalizeActivity(input as Record<string, unknown>);
  const eventId =
    (input.chunk_id as string) || (input.event_id as string) || "";
  const explicitStatus = input.status;
  const status = mapStatus(
    explicitStatus || inferStatusFromResult(normalized.result)
  );

  const rawFunctionName =
    ((input as { functionName?: string }).functionName as string | undefined) ||
    ((input as { function?: string }).function as string | undefined);
  const shellInput = input as {
    shellPid?: number;
    shell_pid?: number;
    shellProcessStatus?: UniversalEventProps["shellProcessStatus"];
    shell_process_status?: UniversalEventProps["shellProcessStatus"];
    shellExitCode?: number;
    shell_exit_code?: number;
    shellLogPath?: string;
    shell_log_path?: string;
  };

  return {
    eventId,
    eventType,
    functionName: rawFunctionName,
    filePath:
      (input as { filePath?: string; file_path?: string }).filePath ||
      (input as { filePath?: string; file_path?: string }).file_path,
    repoPath:
      (input as { repoPath?: string; repo_path?: string }).repoPath ||
      (input as { repoPath?: string; repo_path?: string }).repo_path,
    args: normalized.args,
    result: normalized.result,
    llmUsage: readLlmUsageMetadata(normalized.args),
    status,
    timestamp: normalized.createdAt,
    showActiveEventPainting: shouldShowActiveEventPainting(
      status,
      normalized.createdAt
    ),
    shellPid: shellInput.shellPid ?? shellInput.shell_pid,
    shellProcessStatus:
      shellInput.shellProcessStatus ?? shellInput.shell_process_status,
    shellExitCode: shellInput.shellExitCode ?? shellInput.shell_exit_code,
    shellLogPath: shellInput.shellLogPath ?? shellInput.shell_log_path,
    variant,
    context,
    isSelected: input.isSelected,
    onSelect: input.onSelect,
    animation,
    itemIndex: input.itemIndex,
    streamingContent: input.streamingContent,
    isStreaming: input.isStreaming,
    rustExtracted: (input as { extracted?: unknown }).extracted as
      | UniversalEventProps["rustExtracted"]
      | undefined,
    payloadRefs: (input as { payloadRefs?: unknown }).payloadRefs as
      | UniversalEventProps["payloadRefs"]
      | undefined,
  };
}

// ============================================
// React Hook
// ============================================

/**
 * Hook to normalize event props
 * Memoized for performance
 */
export function useNormalizedEventProps(
  input: RawEventInput,
  eventType: string
): UniversalEventProps | null {
  return useMemo(
    () => normalizeEventProps(input, eventType),
    [input, eventType]
  );
}
