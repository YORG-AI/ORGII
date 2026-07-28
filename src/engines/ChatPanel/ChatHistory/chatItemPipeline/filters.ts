/**
 * Chat Item Pipeline — Pre-render Content Filters
 *
 * Determines whether a SessionEvent will produce visible UI.
 * Used at pipeline stage to skip items that would render as null,
 * saving render cycles and improving list performance.
 *
 * NOTE: Uses normalizeFunctionName() to resolve CLI adapter aliases to ui_canonical
 * form (Rust source of truth via cli_agents/alias_map.rs).
 */
import { getActionConfig } from "@src/engines/ChatPanel/ChatHistory/ActionRegistry";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  PLAN_EVENT_NAME,
  isPlanApprovalEvent,
  isRehydratedPlanApprovalEvent,
  isStreamingPlanDraftEvent,
  isSubmittedCreatePlanEvent,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import {
  extractThinkContent,
  stripThinkTags,
} from "@src/engines/SessionCore/sync/adapters/shared/streamingParsers";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";
import {
  extractAssistantMessageContent,
  extractTextFromContent,
} from "@src/lib/activityData/textExtractors";

/**
 * Check if event will render content (pre-filter to avoid wasted renders).
 * Used by pipeline.ts and ExtendedItemRenderers which operate on SessionEvent[].
 */
function hasShellCommand(event: SessionEvent): boolean {
  return !!(
    event.command ||
    (typeof event.args?.["command"] === "string" &&
      event.args["command"].trim())
  );
}

/**
 * Mirrors AgentMessageEvent's text extraction (stream/agent-message/index.tsx
 * `extractText` + the rawContent fallback chain). Returns true if the event
 * has any text source that would survive into the chat bubble — used to
 * suppress empty agent_message wrappers.
 */
function hasAgentMessageBody(event: SessionEvent): boolean {
  const assistantContent = extractAssistantMessageContent(event);
  if (assistantContent) {
    const visibleContent = stripThinkTags(assistantContent).trim();
    const thinkingContent = extractThinkContent(assistantContent);
    return Boolean(visibleContent || thinkingContent);
  }
  const taskDescription = event.args?.["task_description"];
  if (typeof taskDescription === "string" && taskDescription.trim())
    return true;
  return false;
}

function hasRawUserBody(event: SessionEvent): boolean {
  const messageText = extractTextFromContent(event.result?.["message"]);
  const contentText = extractTextFromContent(event.result?.["content"]);
  if (messageText || contentText) return true;
  const images = event.result?.["images"];
  return Array.isArray(images) && images.length > 0;
}

function hasThinkingBody(event: SessionEvent): boolean {
  const thought = event.result?.["thought"];
  const content = event.result?.["content"];
  const observation = event.result?.["observation"];
  const argsContent = event.args?.["content"];

  return !!(
    (typeof thought === "string" && thought.trim()) ||
    (typeof content === "string" && content.trim()) ||
    (typeof observation === "string" && observation.trim()) ||
    (typeof argsContent === "string" && argsContent.trim()) ||
    event.displayText.trim()
  );
}

export function hasThinkingEventType(
  event: SessionEvent,
  normalized = event.uiCanonical || normalizeFunctionName(event.functionName)
): boolean {
  const normalizedActionType = normalizeFunctionName(event.actionType);
  return (
    event.displayVariant === "thinking" ||
    normalized === "thinking" ||
    normalizedActionType === "thinking"
  );
}

function hasShellOutput(result: Record<string, unknown>): boolean {
  const success = result.success as Record<string, unknown> | undefined;
  const failure = result.failure as Record<string, unknown> | undefined;
  const output = result.output as Record<string, unknown> | undefined;
  const outputSuccess = output?.success as Record<string, unknown> | undefined;
  const outputFailure = output?.failure as Record<string, unknown> | undefined;

  return !!(
    result["stdout"] ||
    result["stderr"] ||
    result["output"] ||
    result["observation"] ||
    result["interleaved_output"] ||
    success?.stdout ||
    success?.stderr ||
    success?.interleaved_output ||
    success?.interleavedOutput ||
    failure?.stdout ||
    failure?.stderr ||
    failure?.interleaved_output ||
    failure?.interleavedOutput ||
    outputSuccess?.stdout ||
    outputSuccess?.stderr ||
    outputSuccess?.interleaved_output ||
    outputSuccess?.interleavedOutput ||
    outputFailure?.stdout ||
    outputFailure?.stderr ||
    outputFailure?.interleaved_output ||
    outputFailure?.interleavedOutput
  );
}

const willRenderContentCache = new WeakMap<SessionEvent, boolean>();

/**
 * Memoized `willEventRenderContent`. Events are immutable (copy-on-write via
 * `snapshotMaterialization.swapChangedEvents`), so a given event object's
 * classification never changes and the cached verdict stays valid. The chat
 * projection re-runs over the full event list on every new event in a turn;
 * without this cache each re-run re-ran the full
 * `stripThinkTags`/`extractThinkContent`/`hasShellOutput` classification over
 * every prior event (O(n) per new event → O(n²) per turn). The registry it
 * consults (`getActionConfig`) is static, so there is no staleness window.
 */
export function willEventRenderContent(event: SessionEvent): boolean {
  const cached = willRenderContentCache.get(event);
  if (cached !== undefined) return cached;
  const result = computeWillEventRenderContent(event);
  willRenderContentCache.set(event, result);
  return result;
}

function computeWillEventRenderContent(event: SessionEvent): boolean {
  const actionType = event.actionType;
  const functionName = event.functionName;

  // Use pre-computed uiCanonical from ingestion (already normalized)
  const normalized = event.uiCanonical || normalizeFunctionName(functionName);

  if (hasThinkingEventType(event, normalized)) {
    return hasThinkingBody(event);
  }

  // Assistant/agent messages render only when they actually carry text
  // (either streaming, displayText, a result body, or a task_description arg).
  // Without this guard, an agent_message whose payload landed only in <think>
  // tags — or arrived empty — would still produce an empty ChatItemWrap
  // bubble between real messages.
  if (
    actionType === "assistant" ||
    event.uiCanonical === "assistant_message" ||
    functionName === "assistant_message" ||
    functionName === "agent_message" ||
    (event.source === "assistant" && event.displayVariant === "message")
  ) {
    return hasAgentMessageBody(event);
  }

  // raw/raw_event: user messages render, but events with no function and no
  // message/type in result are suppressed (they'd render as null in ActivityRouter).
  if (actionType === "raw" || actionType === "raw_event") {
    if (event.result?.["type"] === "user" || event.result?.["message"]) {
      return hasRawUserBody(event);
    }
    if (!functionName) {
      return false;
    }
  }

  // Plan cards have two renderable shapes:
  // - running raw create_plan tool-call args for streaming draft UI
  // - explicit backend-authored plan_approval lifecycle events for history
  if (isRehydratedPlanApprovalEvent(event)) return false;
  if (isPlanApprovalEvent(event)) return true;
  if (normalized === PLAN_EVENT_NAME.CREATE_PLAN) {
    return (
      isStreamingPlanDraftEvent(event) || isSubmittedCreatePlanEvent(event)
    );
  }

  // Failed events always render (FailedEventRow)
  if (event.displayStatus === "failed") return true;

  // Shell commands render when the command itself is known, even if the CLI
  // reports an empty stdout/stderr payload.
  if (normalized === "run_shell") {
    if (hasShellCommand(event)) return true;
    const result = event.result;
    return result ? hasShellOutput(result) : false;
  }

  // manage_todo: skip running (streaming placeholder)
  if (normalized === "manage_todo") {
    const result = event.result;
    if (!result || result["status"] === "running") return false;
  }

  // Edit/patch: skip running only
  if (normalized === "edit_file" || normalized === "apply_patch") {
    const result = event.result;
    if (!result || result["status"] === "running") return false;
  }

  // Read file: skip if still running
  if (normalized === "read_file") {
    const result = event.result;
    if (!result || result["status"] === "running") return false;
  }

  // Check if the normalized UI canonical or raw action/function names are registered.
  const configByNormalized = getActionConfig(normalized);
  if (configByNormalized) return true;

  const configByAction = getActionConfig(actionType);
  if (configByAction) return true;

  if (functionName) {
    const configByFunction = getActionConfig(functionName);
    if (configByFunction) return true;
  }

  // Fallback: check observation string or display text
  const observation = event.result?.["observation"];
  if (observation && typeof observation === "string") return true;
  return !!event.displayText;
}
