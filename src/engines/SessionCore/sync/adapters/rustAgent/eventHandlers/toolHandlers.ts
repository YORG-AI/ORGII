/**
 * Tool Handlers
 *
 * Handlers for tool_call, tool_result, and interaction finalization events.
 * Shell process / exec-output handlers live in shellHandlers.ts.
 */
import { switchModeForSession } from "@src/engines/ChatPanel/InputArea/ModeSwitchCard/useModeSwitchActions";
import { openInSimulatorCanvas } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/openInSimulatorCanvas";
import type {
  CanvasInlineMode,
  CanvasInlinePayload,
} from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { createLogger } from "@src/hooks/logger";
import { clearMcpProgressForCallAtom } from "@src/store/session/mcpProgressAtom";
import {
  clearFinalizedPermissionRequest,
  pendingPermissionRequestsAtom,
} from "@src/store/session/permissionRequestAtom";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { makeToolResultEvent } from "../../shared/eventBuilders";
import {
  SPAWNED_SESSION_RE,
  findActiveSubagentCallIndex,
  findSubagentParentEventId,
} from "../../shared/subagentTracking";
import type { AgentWSEvent } from "../../shared/types";
import { clearStreamingInfo, getToolCallId } from "./streamHelpers";
import type { EventHandlerContext } from "./types";

const log = createLogger("ToolHandlers");

function isAutoModeSwitchAccept(
  tool: string | undefined,
  resultObject: Record<string, unknown>
): boolean {
  return (
    tool === "suggest_mode_switch" &&
    resultObject.choice === "switch" &&
    resultObject.auto === "timeout"
  );
}

export function handleToolCall(
  event: AgentWSEvent,
  sessionId: string,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  ctx.onStatusChangeRef.current?.("running");

  if (ctx.assistantStreamRef) {
    ctx.assistantStreamRef.current.contentRef.current = "";
    ctx.assistantStreamRef.current.idRef.current = "";
  }
  if (ctx.thinkingStreamRef) {
    ctx.thinkingStreamRef.current.contentRef.current = "";
    ctx.thinkingStreamRef.current.idRef.current = "";
  }
  clearStreamingInfo(ctx);

  const toolCallId = getToolCallId(event);
  if (!toolCallId) {
    // Every Rust `agent:tool_call` ships with a non-empty call_id; a
    // missing one is a wire-schema bug upstream. Synthesizing an id
    // with `Date.now()` used to mask this by creating a zombie event
    // the later tool_result could never pair with (broke Build-button
    // wiring in the `create_plan` pipeline). Drop the event and log
    // loudly so the bug surfaces instead of being papered over.
    log.warn("[toolHandlers] agent:tool_call dropped — missing tool_call_id", {
      tool: event.tool,
      sessionId,
      eventSessionId,
    });
    return;
  }

  if (ctx.toolCallDeltaBuffersRef) {
    for (const [
      bufferIndex,
      buffer,
    ] of ctx.toolCallDeltaBuffersRef.current.entries()) {
      if (buffer.toolCallId === toolCallId) {
        ctx.toolCallDeltaBuffersRef.current.delete(bufferIndex);
        break;
      }
    }
  }

  // Rust pushes the authoritative `tool-call-${toolCallId}` event into the
  // EventStore before broadcasting `agent:tool_call`. Do not synthesize or
  // upsert a duplicate frontend event here: a delayed broadcast handler can
  // otherwise downgrade an already-completed Rust event back to `running`.

  if (event.tool) {
    window.dispatchEvent(
      new CustomEvent("agent-tool-call", {
        detail: {
          tool: event.tool,
          toolCallId,
          args: event.args ?? {},
          sessionId: eventSessionId,
        },
      })
    );
  }

  // Dispatch canvas-inline-event from tool_call (not tool_result) so the
  // full args payload is available — tool_result only carries a 4000-char
  // preview of the result string, not the original args.
  if (event.tool === "render_inline_canvas" && event.args) {
    dispatchCanvasInlineEventFromArgs(sessionId, event.args, toolCallId);
  }
}

export async function handleToolResult(
  event: AgentWSEvent,
  sessionId: string,
  ctx: EventHandlerContext
): Promise<void> {
  const toolCallId = getToolCallId(event);

  // MCP progress UI: drop any in-flight MCP progress for this
  // tool_call now that the final result has landed.
  if (toolCallId) {
    const store = ctx.getDefaultStore();
    if (store) {
      store.set(clearMcpProgressForCallAtom, {
        sessionId,
        toolCallId,
      });
    }
  }

  // Rust pushes the authoritative `tool-result-${toolCallId}` event into the
  // EventStore before broadcasting `agent:tool_result`; the Rust store then
  // merges it into the matching tool_call by callId and marks it completed.
  // Do not synthesize a frontend result event from this broadcast preview — it
  // can race with/downgrade the authoritative row and may truncate full output.
  if (!ctx.features.hasCodingSessionBridge) return;

  // OS: complex coding session tracking
  const resultContent = event.result || "";

  let trackedParentEventId: string | null = null;
  let shouldMarkParentRunning = false;

  if (
    typeof resultContent === "string" &&
    SPAWNED_SESSION_RE.test(resultContent)
  ) {
    const match = resultContent.match(SPAWNED_SESSION_RE);
    if (match && ctx.trackedCodingSessionsRef) {
      const codingSessionId = match[0];
      const events = await eventStoreProxy.getEvents(sessionId);
      const parentId = findSubagentParentEventId(events, codingSessionId);
      if (!parentId) {
        const activeIdx = findActiveSubagentCallIndex(events);
        if (activeIdx >= 0) {
          const activeEvent = events[activeIdx];
          trackedParentEventId = activeEvent.id;
          shouldMarkParentRunning = true;
          ctx.trackedCodingSessionsRef.current.set(
            codingSessionId,
            activeEvent.id
          );
        }
      } else {
        trackedParentEventId = parentId;
        ctx.trackedCodingSessionsRef.current.set(codingSessionId, parentId);
      }
    }
  }

  // The result row itself is already in the Rust EventStore. The broadcast
  // result is only used here for subagent-session detection above; never
  // downgrade a completed authoritative parent event back to running.

  if (trackedParentEventId && shouldMarkParentRunning) {
    eventStoreProxy.updateById(
      trackedParentEventId,
      {
        displayStatus: "running",
        activityStatus: "agent",
      },
      sessionId
    );
  }
}

const CANVAS_INLINE_MODES = new Set<CanvasInlineMode>([
  "html",
  "url",
  "a2ui",
  "react",
]);

function isCanvasInlineMode(value: unknown): value is CanvasInlineMode {
  return (
    typeof value === "string" &&
    CANVAS_INLINE_MODES.has(value as CanvasInlineMode)
  );
}

/**
 * Dispatch a canvas-inline-event from a `render_inline_canvas` tool_call's
 * args object. Reading from args (not the tool_result string) guarantees the
 * full content is available — the Rust broadcast truncates tool_result to
 * 4 000 chars, which would corrupt large HTML payloads.
 */
function dispatchCanvasInlineEventFromArgs(
  sessionId: string,
  args: Record<string, unknown>,
  toolCallId: string
): void {
  const mode = isCanvasInlineMode(args.mode) ? args.mode : "html";
  const payload: CanvasInlinePayload = {
    mode,
    content: typeof args.content === "string" ? args.content : undefined,
    url: typeof args.url === "string" ? args.url : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    streaming: typeof args.streaming === "boolean" ? args.streaming : undefined,
    eventId: `tool-call-${toolCallId}`,
  };

  openInSimulatorCanvas(sessionId, payload);

  window.dispatchEvent(
    new CustomEvent("canvas-inline-event", {
      detail: { sessionId, payload },
    })
  );
}

/**
 * Handle `agent:interaction_finalized` — authoritative finalize for the three
 * blocking interactive tools (`ask_user_questions`, permission, mode_switch).
 */
export async function handleInteractionFinalized(
  event: AgentWSEvent,
  sessionId: string
): Promise<void> {
  const toolCallId = getToolCallId(event);
  if (!toolCallId) {
    log.warn(
      "[handleInteractionFinalized] missing toolCallId — cannot merge finalize event",
      event
    );
    return;
  }

  const resultObject =
    (event.resultObject as Record<string, unknown> | undefined) ?? {};
  const resultPreview = event.resultPreview ?? "";

  const resultEvent = makeToolResultEvent(
    sessionId,
    event.tool,
    toolCallId,
    resultPreview
  );
  resultEvent.result = {
    ...(resultEvent.result as Record<string, unknown>),
    ...resultObject,
  };
  await eventStoreProxy.mergeEvents([resultEvent], sessionId);

  if (event.tool === "permission" && isStoreInitialized()) {
    const requestId =
      typeof event.requestId === "string" ? event.requestId : undefined;
    getInstrumentedStore().set(pendingPermissionRequestsAtom, (prev) =>
      clearFinalizedPermissionRequest(prev, sessionId, {
        requestId,
        toolCallId,
      })
    );
  }

  if (isAutoModeSwitchAccept(event.tool, resultObject)) {
    const targetMode =
      typeof resultObject.targetMode === "string"
        ? resultObject.targetMode
        : "plan";
    await switchModeForSession(
      sessionId,
      `tool-call-${toolCallId}`,
      targetMode
    );
  }
}

export {
  handleExecOutput,
  handleShellProcessBackgrounded,
  handleShellProcessExited,
  handleShellProcessStarted,
  handleSubagentJobChanged,
} from "./shellHandlers";
