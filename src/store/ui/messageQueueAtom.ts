import { atom } from "jotai";

import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";

// ============================================
// Types
// ============================================

export type QueuedMessagePriority = "now" | "next";

export interface QueuedMessage {
  id: string;
  /**
   * Canonical user-intent id. Minted once at the submit boundary
   * (ChatPanel / queue / Send Now / Resume) and propagated through:
   *
   *   QueuedMessage           (this field)
   *   createSyntheticUserEvent options.turnIntentId
   *   SessionService.sendMessage params.turnIntentId
   *   agent_send_message Tauri command turnIntentId
   *   ScheduledMessage.turn_intent_id
   *   TurnInput.turn_intent_id
   *   persist_user_message_event(... turn_intent_id ...)
   *   session_turn_intents row
   *
   * The turn indexer reads `result.turnIntentId` off both the synthetic
   * row (when the FE supplies one) and the backend-persisted row, and
   * groups them under the same logical round. See the lifecycle store in
   * `session-persistence::turn_intents`.
   */
  turnIntentId: string;
  sessionId: string;
  content: string;
  displayContent: string;
  imageDataUrls?: string[];
  /**
   * Snapshot of model/account selection at enqueue time. Frozen here
   * so a model swap done while the queue is draining cannot retroactively
   * change which model an already-queued message is sent with.
   */
  modelSelection?: LastModelSelection;
  /**
   * Snapshot of the agent exec mode at enqueue time. Same rationale as
   * `modelSelection` — without this snapshot, switching from Plan to
   * Build mid-queue (or being switched by the `mode_switch` card) would
   * silently re-target every still-pending message in the queue.
   * `undefined` means "use whatever mode the session row has at dispatch
   * time" (which is the legacy behaviour and what callers that don't
   * care about a specific mode should keep doing).
   */
  agentExecMode?: AgentExecMode;
  /**
   * Dispatch priority.
   * - "next": natural follow-up — drains FIFO once the turn-lifecycle FSM
   *   reports the session idle.
   * - "now": explicit user dispatch (Send Now, or a submit issued after a
   *   user Stop) — jumps ahead of every "next" item and may interrupt an
   *   active turn via the timeline boundary.
   */
  priority: QueuedMessagePriority;
  /**
   * Set when the user pressed Stop while this message was parked. The
   * natural drain skips these permanently; only an explicit user action
   * (Send Now — which flips priority to "now" and clears this flag) can
   * dispatch them.
   */
  requiresExplicitDispatch?: boolean;
  status: "queued";
  createdAt: string;
}

// ============================================
// Core Atom — THE single queue
// ============================================

export const messageQueueAtom = atom<QueuedMessage[]>([]);
messageQueueAtom.debugLabel = "messageQueueAtom";

/** True once the durable queue snapshot has been merged into this Jotai store. */
export const messageQueueHydratedAtom = atom(false);
messageQueueHydratedAtom.debugLabel = "messageQueueHydratedAtom";

/** Tracks which queued message is currently being edited in the main input box. */
export interface QueueEditTarget {
  messageId: string;
  content: string;
  imageDataUrls?: string[];
}
export const queueEditTargetAtom = atom<QueueEditTarget | null>(null);
queueEditTargetAtom.debugLabel = "queueEditTargetAtom";

/** True while a queued message is being edited — dispatch is paused. Derived from queueEditTargetAtom. */
export const queueEditingAtom = atom(
  (get) => get(queueEditTargetAtom) !== null
);
queueEditingAtom.debugLabel = "queueEditingAtom";

// ============================================
// Write Atoms
// ============================================

/**
 * Incremented each time a message is enqueued.
 * Components can watch this to react to new enqueues without using effects.
 */
export const enqueueCountAtom = atom(0);
enqueueCountAtom.debugLabel = "enqueueCountAtom";

export const enqueueMessageAtom = atom(
  null,
  (_get, set, message: QueuedMessage) => {
    let added = false;
    set(messageQueueAtom, (prev) => {
      // Dedupe by canonical user-intent id. Falls back to content-
      // equality only when the caller hasn't minted an id yet (legacy
      // entry points during the migration window). Once every submit
      // boundary mints, the content fallback becomes dead code and can
      // be removed.
      const duplicate = prev.some((existing) =>
        message.turnIntentId
          ? existing.turnIntentId === message.turnIntentId
          : existing.sessionId === message.sessionId &&
            existing.content === message.content &&
            existing.displayContent === message.displayContent
      );
      if (duplicate) return prev;
      added = true;
      return [...prev, message];
    });
    if (added) set(enqueueCountAtom, (n) => n + 1);
  }
);
enqueueMessageAtom.debugLabel = "enqueueMessageAtom";

export const dequeueMessageAtom = atom(null, (_get, set, messageId: string) => {
  set(messageQueueAtom, (prev) => prev.filter((msg) => msg.id !== messageId));
});
dequeueMessageAtom.debugLabel = "dequeueMessageAtom";

/**
 * Send Now: promote a parked message to an explicit "now" dispatch. The
 * queue dispatcher interrupts the active turn (timeline boundary) if needed
 * and dispatches this message the moment the session is idle. Clearing
 * `requiresExplicitDispatch` lifts a previous Stop hold — Send Now IS the
 * explicit dispatch.
 */
export const forceSendMessageAtom = atom(
  null,
  (get, set, messageId: string) => {
    if (!get(messageQueueAtom).some((msg) => msg.id === messageId)) return;
    set(messageQueueAtom, (prev) =>
      prev.map((msg) =>
        msg.id === messageId
          ? { ...msg, priority: "now", requiresExplicitDispatch: false }
          : msg
      )
    );
  }
);
forceSendMessageAtom.debugLabel = "forceSendMessageAtom";

/**
 * Stop boundary: park every queued message of the session. Held messages are
 * permanently skipped by the natural drain — only Send Now (or queue edit
 * actions) can dispatch them afterwards.
 */
export const holdSessionQueueForStopAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(messageQueueAtom, (prev) =>
      prev.map((msg) =>
        msg.sessionId === sessionId && !msg.requiresExplicitDispatch
          ? { ...msg, requiresExplicitDispatch: true }
          : msg
      )
    );
  }
);
holdSessionQueueForStopAtom.debugLabel = "holdSessionQueueForStopAtom";

export const clearSessionQueueAtom = atom(
  null,
  (_get, set, sessionId: string) => {
    set(messageQueueAtom, (prev) =>
      prev.filter((msg) => msg.sessionId !== sessionId)
    );
  }
);
clearSessionQueueAtom.debugLabel = "clearSessionQueueAtom";

export const editMessageAtom = atom(
  null,
  (
    _get,
    set,
    update: {
      messageId: string;
      content: string;
      imageDataUrls?: string[];
      modelSelection?: LastModelSelection;
      agentExecMode?: AgentExecMode;
    }
  ) => {
    set(messageQueueAtom, (prev) =>
      prev.map((msg) =>
        msg.id === update.messageId
          ? {
              ...msg,
              content: update.content,
              displayContent: update.content,
              ...(update.imageDataUrls !== undefined && {
                imageDataUrls: update.imageDataUrls,
              }),
              ...(update.modelSelection !== undefined && {
                modelSelection: update.modelSelection,
              }),
              ...(update.agentExecMode !== undefined && {
                agentExecMode: update.agentExecMode,
              }),
            }
          : msg
      )
    );
  }
);
editMessageAtom.debugLabel = "editMessageAtom";

/**
 * Bumped to request an immediate queue dispatch pass (e.g. "Send Now"
 * clicked, or a post-Stop explicit submit was enqueued). Watched by
 * useQueueDispatch.
 */
export const queueFlushRequestAtom = atom(0);
queueFlushRequestAtom.debugLabel = "queueFlushRequest";

export const reorderQueueAtom = atom(
  null,
  (
    _get,
    set,
    { fromIndex, toIndex }: { fromIndex: number; toIndex: number }
  ) => {
    set(messageQueueAtom, (prev) => {
      if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= prev.length ||
        toIndex >= prev.length
      ) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }
);
reorderQueueAtom.debugLabel = "reorderQueueAtom";
