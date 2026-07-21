/**
 * useQueueDispatch Hook — the single queue dispatcher.
 *
 * SINGLETON — must be mounted exactly once (in GlobalSessionSync).
 *
 * Drains `messageQueueAtom` strictly against the turn-lifecycle FSM
 * (`turnLifecycle.ts`). There is exactly one rule set:
 *
 *   - "now" priority (Send Now / post-Stop explicit submit):
 *       · session idle      → dispatch immediately.
 *       · session active    → request ONE timeline-boundary interrupt for it,
 *                             then dispatch when the provider terminal lands.
 *       · session stopping  → wait for the terminal (bounded by the FSM
 *                             stopping dead-man).
 *   - "next" priority (natural follow-ups):
 *       · dispatched FIFO, only when the session FSM is idle and the message
 *         is not held (`requiresExplicitDispatch` — set by a user Stop).
 *       · held messages are NEVER drained naturally; only Send Now can
 *         dispatch them.
 *
 * No runtime-status reads, no rendered-event heuristics, no timestamps or
 * stabilization windows: turn finality is exactly what the FSM says.
 */
import type { Atom } from "jotai";
import { useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  enterAgentOrgSessionIntervention,
  getSession,
} from "@src/api/tauri/agent";
import { Message } from "@src/components/Message";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { cancelTurnForTimelineBoundary } from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import { publishTurnIntentDispatch } from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  confirmTurnRunning,
  getTurnPhase,
  markTurnTerminal,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared";
import { createLogger } from "@src/hooks/logger";
import { markSessionActive } from "@src/store/session";
import {
  lastUserMessageAtom,
  setSessionRuntimeStatusAtom,
  userInitiatedCancelAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import {
  type QueuedMessage,
  messageQueueAtom,
  queueEditingAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import { selectionFromSession } from "@src/util/session/selectionFromSession";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

import {
  type BackendDispatchVerdict,
  classifyBackendSessionStatus,
} from "./backendDispatchVerdict";

const log = createLogger("useQueueDispatch");

const MAX_SENT_QUEUE_ID_CACHE = 200;

/**
 * Natural follow-ups stay visible in the queue UI for at least this long so
 * a fast turn completion does not make the queued bubble flash and vanish.
 * Explicit "now" dispatches skip this — the user just asked for it.
 */
const MIN_QUEUE_VISIBLE_MS = 1_200;

function queuedMessageAgeMs(message: QueuedMessage): number {
  const createdAtMs = Date.parse(message.createdAt);
  if (!Number.isFinite(createdAtMs)) return MIN_QUEUE_VISIBLE_MS;
  return Date.now() - createdAtMs;
}

/** Re-check cadence while the backend reports the session still busy. */
const QUEUE_BACKEND_RECHECK_MS = 3_000;

/**
 * Authoritative pre-dispatch gate for the natural FIFO drain.
 *
 * The turn-lifecycle FSM can be forced idle without a real provider terminal
 * (planning watchdog, dispatching dead-man, rewind boundary, stray
 * session-status broadcasts). Dispatching on a falsely-idle FSM injects the
 * queued message into the middle of a still-running turn — or into a session
 * that already died. This asks the backend — the only authority on execution
 * — before letting a natural drain proceed. Fail-open ("ready") on RPC
 * errors: if the backend is unreachable the dispatch itself will fail and
 * park the message.
 */
async function getBackendDispatchVerdict(
  sessionId: string
): Promise<BackendDispatchVerdict> {
  try {
    if (isCliSession(sessionId)) {
      const status = (await invokeTauri("cli_agent_status", { sessionId })) as {
        status?: string;
      } | null;
      return classifyBackendSessionStatus(status?.status);
    }
    if (isAgentSession(sessionId)) {
      const meta = await getSession(sessionId);
      return classifyBackendSessionStatus(meta?.status);
    }
    return "ready";
  } catch {
    return "ready";
  }
}

export function useQueueDispatch(): void {
  const store = useStore();

  // ── Dispatch lock ─────────────────────────────────────────────────────────
  // One dispatch at a time, globally. The in-flight id additionally guards
  // the window between a successful send and the dequeue write.
  const dispatchLockRef = useRef(false);
  const inFlightMessageIdRef = useRef<string | null>(null);

  // Send Now interrupt bookkeeping: one boundary interrupt per message.
  const interruptRequestedByMessageIdRef = useRef<Set<string>>(new Set());

  // Already-sent ids (bounded LRU) so a stale queue snapshot can never
  // double-send a message that already became a user turn.
  const sentQueuedMessageIdsRef = useRef<Set<string>>(new Set());
  const sentQueuedMessageIdOrderRef = useRef<string[]>([]);
  const rememberSentQueueId = useCallback((messageId: string) => {
    if (sentQueuedMessageIdsRef.current.has(messageId)) return;
    sentQueuedMessageIdsRef.current.add(messageId);
    sentQueuedMessageIdOrderRef.current.push(messageId);
    while (
      sentQueuedMessageIdOrderRef.current.length > MAX_SENT_QUEUE_ID_CACHE
    ) {
      const expiredId = sentQueuedMessageIdOrderRef.current.shift();
      if (expiredId) sentQueuedMessageIdsRef.current.delete(expiredId);
    }
  }, []);

  // Pending wake-up for MIN_QUEUE_VISIBLE_MS waits.
  const wakeTimerRef = useRef<number | null>(null);
  const tryDispatchNextRef = useRef<() => void>(() => {});

  const dispatchMessage = useCallback(
    (msg: QueuedMessage, onDone: () => void) => {
      const { sessionId, content, displayContent, imageDataUrls } = msg;

      // Snapshot-first model/mode resolution: the QueuedMessage carries the
      // selection frozen at enqueue time; the session-row + creator-default
      // chain only covers legacy entries enqueued before snapshots existed.
      const sessionMap = store.get(sessionMapAtom);
      const session = sessionMap.get(sessionId);
      const lastModelSelection: LastModelSelection | null =
        msg.modelSelection ??
        selectionFromSession(
          session,
          store.get(creatorDefaultModelSelectionAtom)
        );
      const agentExecMode: AgentExecMode =
        msg.agentExecMode ??
        (session?.agentExecMode as AgentExecMode | undefined) ??
        store.get(creatorDefaultExecModeAtom);
      const { model, accountId } = resolveModelForMessage(lastModelSelection);

      // Synchronous turn reserve BEFORE any await: from this instant every
      // submit and every other dispatch pass observes the session as busy.
      const dispatchGeneration = beginTurnDispatch(sessionId);
      publishTurnIntentDispatch(msg.turnIntentId, {
        sessionId,
        generation: dispatchGeneration,
      });

      // An explicit dispatch concludes any pending stop episode.
      if (msg.priority === "now") {
        store.set(userInitiatedCancelAtom, false);
      }

      // Capture the payload for Stop-restore before the async append.
      store.set(lastUserMessageAtom, {
        sessionId,
        displayContent,
        imageDataUrls,
      });

      beginOptimisticTurn(sessionId, "queue");

      void (async () => {
        try {
          const userEvent = createSyntheticUserEvent(
            sessionId,
            displayContent,
            {
              imageDataUrls,
              turnIntentId: msg.turnIntentId,
            }
          );
          await eventStoreProxy.append([userEvent], sessionId);
          // A queued user turn becomes a takeover only when it is actually
          // dispatched. Merely waiting in the queue must not suppress Wake.
          await enterAgentOrgSessionIntervention(sessionId);
          // Pass displayContent as displayText when it differs from content
          // (i.e. skill pills were expanded) so the persisted event stores
          // the pill format and re-editing shows the pill, not the YAML.
          const displayTextForDispatch =
            content !== displayContent ? displayContent : undefined;
          await SessionService.sendMessage({
            sessionId,
            content,
            displayText: displayTextForDispatch,
            model,
            accountId,
            mode: agentExecMode,
            imageDataUrls,
            clientMessageId: `queued:${sessionId}:${msg.id}`,
            turnIntentId: msg.turnIntentId,
          });
          // Backend accepted the message — confirm the turn as running.
          confirmTurnRunning(sessionId);
          // Bump activity timestamps so the just-flushed session surfaces in
          // "recent activity" views without waiting for the next refresh.
          markSessionActive(sessionId);
          rememberSentQueueId(msg.id);
          store.set(messageQueueAtom, (prev) =>
            prev.filter((item) => item.id !== msg.id)
          );
          onDone();
          if (isCursorIdeSession(sessionId)) {
            // Cursor IDE sessions have no turn lifecycle (no terminal event
            // stream) — close the turn right after a successful handoff.
            store.set(setSessionRuntimeStatusAtom, {
              sessionId,
              status: "idle",
              source: "queue",
            });
            markTurnTerminal(sessionId, "completed", {
              generation: dispatchGeneration,
            });
          }
        } catch (err) {
          log.error("[useQueueDispatch] dispatch failed:", err);
          // IPC failed before the backend received the message: close the
          // reserved turn and park the message so it does not retry in a
          // tight loop — the user can fix the issue and press Send Now.
          failOptimisticTurn(sessionId, "queue");
          markTurnTerminal(sessionId, "failed", {
            generation: dispatchGeneration,
          });
          store.set(messageQueueAtom, (prev) =>
            prev.map((item) =>
              item.id === msg.id
                ? { ...item, priority: "next", requiresExplicitDispatch: true }
                : item
            )
          );
          onDone();
          const detail = err instanceof Error ? err.message : String(err);
          Message.error({
            content: `Failed to send message: ${detail}`,
            duration: 5000,
          });
        }
      })();
    },
    [rememberSentQueueId, store]
  );

  const tryDispatchNext = useCallback(() => {
    if (wakeTimerRef.current !== null) {
      window.clearTimeout(wakeTimerRef.current);
      wakeTimerRef.current = null;
    }
    if (dispatchLockRef.current) return;
    if (store.get(queueEditingAtom)) return;

    const queue = store.get(messageQueueAtom);
    if (queue.length === 0) return;

    const candidates = queue.filter(
      (msg) =>
        msg.id !== inFlightMessageIdRef.current &&
        !sentQueuedMessageIdsRef.current.has(msg.id)
    );

    // ── Explicit "now" dispatches take absolute precedence ─────────────────
    const explicitMsg = candidates.find((msg) => msg.priority === "now");
    if (explicitMsg) {
      const phase = getTurnPhase(explicitMsg.sessionId);
      if (phase === "idle") {
        dispatchLockRef.current = true;
        inFlightMessageIdRef.current = explicitMsg.id;
        dispatchMessage(explicitMsg, () => {
          if (inFlightMessageIdRef.current === explicitMsg.id) {
            inFlightMessageIdRef.current = null;
          }
          dispatchLockRef.current = false;
          tryDispatchNextRef.current();
        });
        return;
      }
      if (
        (phase === "working" || phase === "dispatching") &&
        !interruptRequestedByMessageIdRef.current.has(explicitMsg.id)
      ) {
        // Send Now against an active turn: interrupt it once. The provider's
        // cancelled terminal flips the FSM idle, which re-triggers this pass
        // and dispatches the message above.
        interruptRequestedByMessageIdRef.current.add(explicitMsg.id);
        void cancelTurnForTimelineBoundary(
          explicitMsg.sessionId,
          "force-send"
        ).catch((error) => {
          log.warn("[useQueueDispatch] force-send interrupt failed:", error);
        });
      }
      // stopping (or interrupt already requested): wait for the terminal.
      return;
    }

    // ── Natural FIFO drain ──────────────────────────────────────────────────
    for (const msg of candidates) {
      if (msg.requiresExplicitDispatch) continue; // held by a user Stop
      if (getTurnPhase(msg.sessionId) !== "idle") continue; // turn active
      const remainingVisibleMs = MIN_QUEUE_VISIBLE_MS - queuedMessageAgeMs(msg);
      if (remainingVisibleMs > 0) {
        wakeTimerRef.current = window.setTimeout(() => {
          wakeTimerRef.current = null;
          tryDispatchNextRef.current();
        }, remainingVisibleMs);
        return;
      }
      dispatchLockRef.current = true;
      inFlightMessageIdRef.current = msg.id;
      // Authoritative gate: the FSM can be forced idle without a real
      // provider terminal (watchdog / dead-man / rewind). Confirm with the
      // backend before injecting a natural follow-up into the session.
      void getBackendDispatchVerdict(msg.sessionId).then((verdict) => {
        if (inFlightMessageIdRef.current !== msg.id) return;
        if (verdict === "busy") {
          // Still executing — back off and re-check. Do NOT mark the FSM:
          // presentation state may legitimately disagree; the queue only
          // needs to know "not yet".
          inFlightMessageIdRef.current = null;
          dispatchLockRef.current = false;
          if (wakeTimerRef.current === null) {
            wakeTimerRef.current = window.setTimeout(() => {
              wakeTimerRef.current = null;
              tryDispatchNextRef.current();
            }, QUEUE_BACKEND_RECHECK_MS);
          }
          return;
        }
        if (verdict === "dead") {
          // The session terminated as failed/killed — a natural dispatch
          // would be accepted by the IPC layer and then silently swallowed
          // (no scheduler turn ever runs in a dead session). Park the
          // message visibly instead: it stays in the queue UI flagged for
          // explicit dispatch, so the user can Send Now (restart attempt),
          // edit it, or move it elsewhere. Never silently drop it.
          inFlightMessageIdRef.current = null;
          dispatchLockRef.current = false;
          store.set(messageQueueAtom, (prev) =>
            prev.map((item) =>
              item.id === msg.id
                ? { ...item, requiresExplicitDispatch: true }
                : item
            )
          );
          Message.warning({
            content: `Session has ended — queued message was kept on hold. Use Send Now to dispatch it explicitly.`,
            duration: 6000,
          });
          tryDispatchNextRef.current();
          return;
        }
        if (getTurnPhase(msg.sessionId) !== "idle") {
          // FSM re-busied while we were checking (a real dispatch won).
          inFlightMessageIdRef.current = null;
          dispatchLockRef.current = false;
          tryDispatchNextRef.current();
          return;
        }
        dispatchMessage(msg, () => {
          if (inFlightMessageIdRef.current === msg.id) {
            inFlightMessageIdRef.current = null;
          }
          dispatchLockRef.current = false;
          tryDispatchNextRef.current();
        });
      });
      return;
    }
  }, [dispatchMessage, store]);

  useEffect(() => {
    tryDispatchNextRef.current = tryDispatchNext;
  }, [tryDispatchNext]);

  useEffect(() => {
    const unsubscribers = [
      store.sub(messageQueueAtom as Atom<QueuedMessage[]>, tryDispatchNext),
      store.sub(turnLifecycleSignalAtom as Atom<number>, tryDispatchNext),
      store.sub(queueFlushRequestAtom as Atom<number>, tryDispatchNext),
      store.sub(queueEditingAtom as Atom<boolean>, tryDispatchNext),
    ];
    tryDispatchNext();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      if (wakeTimerRef.current !== null) {
        window.clearTimeout(wakeTimerRef.current);
        wakeTimerRef.current = null;
      }
    };
  }, [store, tryDispatchNext]);
}
