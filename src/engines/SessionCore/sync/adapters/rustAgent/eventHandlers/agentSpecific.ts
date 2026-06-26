/**
 * Feature-Gated Handlers
 *
 * Handlers gated by session feature flags.
 * ade_action, todos_updated, permission:request, question_request
 */
import { rpc } from "@src/api/tauri/rpc";
import {
  type AgentExecMode,
  DEFAULT_AGENT_EXEC_MODE,
  normalizeAgentExecMode,
} from "@src/config/sessionCreatorConfig";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { sanitizeTodoDisplayText } from "@src/engines/SessionCore/hooks/session/todoNormalization";
import { createLogger } from "@src/hooks/logger";
import {
  clearPendingPlanApproval,
  pendingPlanApprovalsAtom,
  upsertPendingPlanApproval,
} from "@src/store/session/planApprovalAtom";
import { sessionByIdAtom, upsertSession } from "@src/store/session/sessionAtom";
import {
  type TodoItem,
  clearTodosForSessionAtom,
  updateTodosForSessionAtom,
} from "@src/store/ui/todoAtom";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import type {
  AgentWSEvent,
  ExitPlanModeEvent,
  PermissionRequestEvent,
  PlanReadyForApprovalEvent,
  QuestionRequestEvent,
} from "../../shared/types";
import {
  clearStreamingInfo,
  getEventSessionId,
  getToolCallId,
} from "./streamHelpers";
import type { EventHandlerContext } from "./types";

const log = createLogger("AgentSpecificHandlers");

// Validate against the FULL `AgentExecMode` union (not just the picker
// entries in `AGENT_EXEC_MODES`). The picker omits `wingman` and `review`,
// but Rust legitimately emits both — silently coercing them to `"build"`
// would re-enable write tools on a passive/review session.
function coerceAgentExecMode(raw: string | undefined): AgentExecMode {
  return normalizeAgentExecMode(raw) ?? DEFAULT_AGENT_EXEC_MODE;
}

// ============================================================================
// ADE action handlers
// ============================================================================

export function handleAdeAction(event: AgentWSEvent): void {
  if (event.correlationId && (event.action || event.operation)) {
    window.dispatchEvent(
      new CustomEvent("agent-ade-action", {
        detail: {
          correlationId: event.correlationId,
          operation: event.operation,
          action: event.action,
          params: event.params ?? {},
          sessionId: getEventSessionId(event),
        },
      })
    );
  }
}

// ============================================================================
// File change / permission / question handlers
// ============================================================================

export function handleTodosUpdated(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  if (!eventSessionId || !event.todos || !Array.isArray(event.todos)) return;

  const store = ctx.getDefaultStore();
  if (!store) return;

  const todos: TodoItem[] = event.todos.map((raw: unknown, idx: number) => {
    const item = raw as Record<string, unknown>;
    const activeForm = item.activeForm;
    const rawBlockedBy = item.blockedBy;
    const blockedBy =
      Array.isArray(rawBlockedBy) && rawBlockedBy.length > 0
        ? (rawBlockedBy as number[])
        : undefined;
    return {
      id: (item.id as string) || `ipc-todo-${idx}`,
      content: sanitizeTodoDisplayText((item.content as string) || ""),
      activeForm:
        typeof activeForm === "string" && activeForm.length > 0
          ? sanitizeTodoDisplayText(activeForm)
          : undefined,
      status: ((item.status as string) || "pending") as TodoItem["status"],
      blockedBy,
    };
  });

  if (todos.length > 0) {
    store.set(updateTodosForSessionAtom, {
      sessionId: eventSessionId,
      todos,
      merge: false,
    });
  }
}

export function handlePermissionRequest(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const reqId = event.requestId;
  if (reqId && eventSessionId && ctx.onPermissionRequestRef) {
    const agentType = getRustAgentType(eventSessionId);

    const permEvent: PermissionRequestEvent = {
      requestId: reqId,
      sessionId: eventSessionId,
      tool: event.toolName || event.tool || "unknown",
      toolCallId: getToolCallId(event),
      args: event.toolArgs ?? event.args ?? {},
      agentType,
    };
    ctx.onPermissionRequestRef.current?.(permEvent);

    // Dispatch unified event for PermissionCard
    window.dispatchEvent(
      new CustomEvent("agent-permission-request", { detail: permEvent })
    );
  }
}

// ============================================================================
// Plan approval (non-blocking flow)
//
//   agent:plan_ready_for_approval   → upsert pendingPlanApprovalsAtom.current
//   agent:exit_plan_mode            → clear current + flip creatorDefaultExecModeAtom
//
// `agent:plan_approval_archived` is not stored as a separate frontend
// state source. The paired `plan_ready_for_approval` updates the current
// action surface, while transcript rendering coalesces only the raw
// streaming draft and lifecycle status events for the same revision.
// ============================================================================

function makePlanApprovalEvent(options: {
  event: AgentWSEvent;
  eventSessionId: string;
  status: "pending" | "archived";
}): SessionEvent | null {
  const planRevisionId = options.event.planRevisionId;
  if (!planRevisionId) return null;

  const eventId =
    options.status === "pending"
      ? planRevisionId
      : `${planRevisionId}-${options.status}`;
  const planTitle = options.event.planTitle ?? "";
  const planContent = options.event.planContent ?? "";
  const planPath = options.event.planPath ?? "";
  const planId = options.event.planId;
  const originToolCallId = options.event.originToolCallId;

  return {
    id: eventId,
    chunk_id: eventId,
    sessionId: options.eventSessionId,
    createdAt: new Date().toISOString(),
    functionName: "plan_approval",
    uiCanonical: "plan_approval",
    actionType: "plan_approval",
    args: {
      title: planTitle,
      content: planContent,
      planPath,
      planId,
      planRevisionId,
      originToolCallId,
      planEventSource: options.event.planEventSource,
    },
    result: {
      status: options.status,
      planId,
      planRevisionId,
      planPath,
    },
    source: "assistant",
    displayText: planTitle,
    displayStatus: options.status === "pending" ? "awaiting_user" : "completed",
    displayVariant: "tool_call",
    activityStatus: options.status === "pending" ? "agent" : "processed",
    callId: planRevisionId,
    isDelta: false,
  };
}

type PlanReadyPayload = Pick<PlanReadyForApprovalEvent, "autoApproveAt">;

export function handlePlanReadyForApproval(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const planPath = event.planPath;
  if (!eventSessionId || !planPath) return;

  const store = ctx.getDefaultStore();
  if (!store) return;

  const planReadyPayload = event as AgentWSEvent & PlanReadyPayload;
  const detail: PlanReadyForApprovalEvent = {
    sessionId: eventSessionId,
    planPath,
    planTitle: event.planTitle ?? "",
    planContent: event.planContent ?? "",
    toolCallId: getToolCallId(event),
    planId: event.planId,
    planRevisionId: event.planRevisionId,
    originToolCallId: event.originToolCallId,
    autoApproveAt:
      typeof planReadyPayload.autoApproveAt === "number"
        ? planReadyPayload.autoApproveAt
        : null,
  };

  store.set(pendingPlanApprovalsAtom, (prev) =>
    upsertPendingPlanApproval(prev, detail)
  );

  const lifecycleEvent = makePlanApprovalEvent({
    event,
    eventSessionId,
    status: "pending",
  });
  if (lifecycleEvent) {
    eventStoreProxy.upsert(lifecycleEvent, eventSessionId);
  }

  if (event.planEventSource === "create_plan") {
    clearStreamingInfo(ctx);
    ctx.setStreaming(false);
    ctx.onStatusChangeRef.current?.("completed");
  }
}

export function handlePlanApprovalArchived(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  if (!eventSessionId || !event.planRevisionId) return;

  // Abandoned / orphaned / superseded resolutions arrive only as this
  // broadcast (no paired plan_ready_for_approval upsert), so the pending
  // atom must be cleared here or the Build card stays pinned.
  const store = ctx.getDefaultStore();
  if (store) {
    store.set(pendingPlanApprovalsAtom, (prev) =>
      clearPendingPlanApproval(prev, eventSessionId, event.planRevisionId)
    );
  }

  void eventStoreProxy.patchByIds(
    [event.planRevisionId, `tool-call-${event.planRevisionId}`],
    {
      result: {
        status: "archived",
        planId: event.planId,
        planRevisionId: event.planRevisionId,
        planPath: event.planPath,
      },
      displayStatus: "completed",
      activityStatus: "processed",
    },
    eventSessionId
  );
}

export function handleExitPlanMode(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  if (!eventSessionId) return;

  const store = ctx.getDefaultStore();
  if (!store) return;

  const detail: ExitPlanModeEvent = {
    sessionId: eventSessionId,
    planPath: event.planPath ?? "",
    planTitle: event.planTitle ?? "",
    toolCallId: getToolCallId(event),
    planId: event.planId,
    planRevisionId: event.planRevisionId,
    originToolCallId: event.originToolCallId,
    restoreMode: event.restoreMode ?? DEFAULT_AGENT_EXEC_MODE,
    edited: !!event.edited,
    rejected: !!event.rejected,
  };
  store.set(pendingPlanApprovalsAtom, (prev) =>
    clearPendingPlanApproval(prev, detail.sessionId, detail.toolCallId)
  );
  // Clear stale plan-phase todos for the session this event belongs to so
  // the Build turn starts with a clean slate. The clear is keyed by
  // eventSessionId so a background session's state is scrubbed in place and
  // the active-session picker is left untouched unless this event *is* for
  // the active session.
  store.set(clearTodosForSessionAtom, eventSessionId);
  if (detail.rejected) {
    ctx.setStreaming(false);
    ctx.onStatusChangeRef.current?.("completed");
  }

  // Restore the per-session exec mode on the row this event belongs to.
  //
  // Why per-session, not the creator-default atom: each Rust session has
  // its own `agent_exec_mode` column now, so a background session
  // exiting plan mode must NOT touch any other session's pill (or the
  // global default for new sessions). The optimistic `upsertSession`
  // mirrors the same shape `useSessionExecModeField` uses so the
  // ModePill on the active session repaints immediately. RPC failure
  // is logged but not rethrown — the event has already had visible
  // side-effects (plan card cleared, todos cleared) so we accept a
  // stale pill over throwing inside an event-stream handler.
  const restoreMode = coerceAgentExecMode(detail.restoreMode);
  const session = store.get(sessionByIdAtom(eventSessionId));
  if (session?.agentExecMode === restoreMode) return;
  if (session) {
    upsertSession({ ...session, agentExecMode: restoreMode });
  }
  rpc.sessionAggregate
    .patch({
      sessionId: eventSessionId,
      patch: { agentExecMode: restoreMode },
    })
    .catch((err) => {
      log.error(
        `[exit_plan_mode] session_patch failed for ${eventSessionId}:`,
        err
      );
    });
}

// ============================================================================
// Shared: question request
// ============================================================================

export function handleQuestionRequest(
  event: AgentWSEvent,
  eventSessionId: string | undefined,
  ctx: EventHandlerContext
): void {
  const reqId = event.requestId;
  if (reqId && eventSessionId) {
    const qToolCallId = getToolCallId(event);
    const qEvent: QuestionRequestEvent = {
      requestId: reqId,
      sessionId: eventSessionId,
      questions: event.questions ?? [],
      toolCallId: qToolCallId,
    };
    ctx.onQuestionRequestRef.current?.(qEvent);

    if (qToolCallId) {
      const toolEventId = `tool-call-${qToolCallId}`;
      // `autoResolveAt` (epoch ms | null) is the backend-authoritative
      // auto-skip deadline from the presence policy. The card renders a
      // countdown from it; the backend resolves regardless of the UI.
      const autoResolveAt =
        typeof event.autoResolveAt === "number" ? event.autoResolveAt : null;
      eventStoreProxy.updateById(
        toolEventId,
        { result: { call_id: reqId, autoResolveAt } },
        eventSessionId
      );
    }
  }
}
