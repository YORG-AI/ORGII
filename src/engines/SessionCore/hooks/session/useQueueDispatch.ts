/**
 * useQueueDispatch Hook — the single queue dispatcher.
 *
 * WINDOW-STORE SINGLETON — mount exactly once for each Jotai/window store.
 * The main window mounts it from GlobalSessionSync; a detached SessionWindow
 * mounts its own instance because its durable queue is keyed by window label.
 * Cross-window turns for the same canonical root are serialized by the
 * injected executor's process-wide root lock.
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
import { useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import { getSession } from "@src/api/tauri/agent";
import { Message } from "@src/components/Message";
import {
  type AgentExecMode,
  resolveSessionAgentExecMode,
} from "@src/config/sessionCreatorConfig";
import { cancelTurnForTimelineBoundary } from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import {
  getTurnGeneration,
  getTurnPhase,
  restoreTurnWorkingAfterInterruptFailure,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { conversationRootKey } from "@src/engines/SessionCore/conversations/conversationTypes";
import {
  QueuedConversationBlockedError,
  QueuedConversationBusyError,
  type QueuedConversationDispatcher,
  QueuedConversationRecoveryBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnClosedError,
  QueuedConversationTurnFailedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { queueDispatchSyncInputsAtom } from "@src/engines/SessionCore/derived/queueDispatchSyncInputsAtom";
import {
  dispatchUserIntent,
  isUserIntentSendError,
  setOptimisticQueueUserDelivery,
} from "@src/engines/SessionCore/services/userIntentDispatch";
import { createLogger } from "@src/hooks/logger";
import {
  closePostStopDispatchEpisodeAtom,
  lastUserMessageAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  type LastModelSelection,
  creatorDefaultModelSelectionAtom,
} from "@src/store/session/creatorDefaultModelAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import {
  type ActiveMessageDelivery,
  type QueuedMessage,
  activeMessageDeliveriesAtom,
  messageQueueAtom,
  messageQueueHandoffIdsAtom,
  messageQueueHydratedAtom,
  queueEditingAtom,
  queuedMessageScopeKey,
} from "@src/store/ui/messageQueueAtom";
import {
  getMessageQueueOwnerKey,
  isPrimaryMessageQueueOwnerKey,
  persistDurableMessageQueue,
  withCanonicalConversationTurnLock,
} from "@src/store/ui/messageQueueRepository";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import { selectionFromSession } from "@src/util/session/selectionFromSession";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

import {
  type BackendDispatchVerdict,
  classifyBackendSessionStatus,
} from "./backendDispatchVerdict";
import {
  assertDurableActiveDeliveryIsRootHead,
  disposeMessageQueuePersistence,
  handoffQueuedMessageToActiveDelivery,
  hydrateMessageQueue,
  refreshMessageDeliveries,
  removeActiveMessageDelivery,
  replaceActiveMessageDeliveryLocally,
  returnActiveDeliveryToMessageQueue,
  updateActiveMessageDelivery,
} from "./messageQueuePersistence";

const log = createLogger("useQueueDispatch");

/** Re-check cadence while the backend reports the session still busy. */
const QUEUE_BACKEND_RECHECK_MS = 3_000;
const CANONICAL_RECOVERY_RETRY_MAX_MS = 60_000;
const CANONICAL_HYDRATION_RETRY_MAX_MS = 30_000;

function canonicalRecoveryDelayMs(attempt: number): number {
  return Math.min(
    QUEUE_BACKEND_RECHECK_MS * 2 ** Math.max(0, attempt - 1),
    CANONICAL_RECOVERY_RETRY_MAX_MS
  );
}

function queuedRetryFromDelivery(
  delivery: ActiveMessageDelivery,
  error?: unknown
): QueuedMessage {
  const {
    originQueueKey: _originQueueKey,
    runnerSessionId: _runnerSessionId,
    runnerEventStartIndex: _runnerEventStartIndex,
    retryAt: _retryAt,
    retryAttempt: _retryAttempt,
    ...message
  } = delivery;
  return {
    ...message,
    priority: "next",
    requiresExplicitDispatch: true,
    status: "queued",
    ...(error
      ? {
          deliveryError: error instanceof Error ? error.message : String(error),
        }
      : {}),
  };
}

function optimisticDeliveryProjectionParams(
  message: QueuedMessage | ActiveMessageDelivery
) {
  return {
    sessionId: message.sessionId,
    visibleText: message.displayContent,
    imageDataUrls: message.imageDataUrls,
    turnIntentId: message.turnIntentId,
    queueMessageId: message.id,
    createdAt: message.createdAt,
  };
}

/**
 * Authoritative pre-dispatch gate for the natural FIFO drain.
 *
 * The turn-lifecycle FSM can be forced idle without a real provider terminal
 * (planning watchdog, dispatching dead-man, rewind boundary, stray
 * session-status broadcasts). Dispatching on a falsely-idle FSM injects the
 * queued message into the middle of a still-running turn — or into a session
 * that already died. This asks the backend — the only authority on execution
 * — before letting a natural drain proceed. Fail closed ("unknown") on RPC
 * errors: a status-read failure does not prove that a turn is idle, so keep
 * the durable queue row visible and retry instead of risking overlap.
 */
async function getBackendDispatchVerdict(
  sessionId: string
): Promise<BackendDispatchVerdict> {
  try {
    if (isCliSession(sessionId)) {
      // CLI finality is push-owned by CliTurnLifecycleCoordinator. Re-reading
      // status here would reintroduce one polling RPC per queued turn.
      return "ready";
    }
    if (isAgentSession(sessionId)) {
      const meta = await getSession(sessionId);
      return classifyBackendSessionStatus(meta?.status);
    }
    return "ready";
  } catch {
    return "unknown";
  }
}

export function useQueueDispatch(
  executeCanonicalConversation?: QueuedConversationDispatcher
): void {
  const store = useStore();
  const messageQueueOwnerKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let hydrationRetryTimer: number | null = null;
    let hydrationAttempt = 0;
    const recoverDelivery = async (): Promise<void> => {
      try {
        messageQueueOwnerKeyRef.current = await getMessageQueueOwnerKey();
        await hydrateMessageQueue(store);
      } catch (error) {
        log.error(
          "[useQueueDispatch] delivery recovery hydration failed closed:",
          error
        );
        if (!disposed) {
          hydrationAttempt += 1;
          const delay = Math.min(
            QUEUE_BACKEND_RECHECK_MS * 2 ** (hydrationAttempt - 1),
            CANONICAL_HYDRATION_RETRY_MAX_MS
          );
          hydrationRetryTimer = window.setTimeout(() => {
            hydrationRetryTimer = null;
            void recoverDelivery();
          }, delay);
        }
      }
    };
    void recoverDelivery();
    return () => {
      disposed = true;
      if (hydrationRetryTimer !== null) {
        window.clearTimeout(hydrationRetryTimer);
      }
      disposeMessageQueuePersistence(store);
    };
  }, [store]);

  useEffect(() => {
    let refreshInFlight: Promise<void> | null = null;
    let trailingRefresh = false;
    const refreshDeliveryProjection = () => {
      if (!store.get(messageQueueHydratedAtom)) return;
      if (refreshInFlight) {
        trailingRefresh = true;
        return;
      }
      refreshInFlight = (async () => {
        do {
          trailingRefresh = false;
          await refreshMessageDeliveries(store);
        } while (trailingRefresh);
      })()
        .catch((error) =>
          log.warn(
            "[useQueueDispatch] failed to refresh delivery projection:",
            error
          )
        )
        .finally(() => {
          refreshInFlight = null;
        });
    };
    const refreshIfVisible = () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState === "visible"
      ) {
        refreshDeliveryProjection();
      }
    };
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [store]);

  // ── Dispatch lock ─────────────────────────────────────────────────────────
  // One dispatch at a time in this window store. The in-flight id additionally
  // guards the window between a successful send and the dequeue write.
  const dispatchLockRef = useRef(false);
  const inFlightMessageIdRef = useRef<string | null>(null);

  // Send Now interrupt bookkeeping: one boundary interrupt per message.
  const interruptRequestedByMessageIdRef = useRef<Set<string>>(new Set());

  const acceptQueuedMessage = useCallback(
    (messageId: string) => {
      interruptRequestedByMessageIdRef.current.delete(messageId);
      store.set(messageQueueAtom, (current) =>
        current.filter((candidate) => candidate.id !== messageId)
      );
    },
    [store]
  );

  const settleQueuedMessageFailure = useCallback(
    async (message: QueuedMessage, error: unknown) => {
      // The durable delivery record remains the retry/edit owner until an
      // accepted send retires it. EventStore is only its transcript
      // projection; transferring ownership to that cache made failed rows
      // disappear after a restart or imported-history refresh.
      if (message.conversationDispatch) {
        try {
          await setOptimisticQueueUserDelivery(
            optimisticDeliveryProjectionParams(message),
            "failed",
            error
          );
        } catch (projectionError) {
          log.error(
            "[useQueueDispatch] could not fail canonical transcript row:",
            projectionError
          );
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      store.set(messageQueueAtom, (current) =>
        current.some((candidate) => candidate.id === message.id)
          ? current.map((candidate) =>
              candidate.id === message.id
                ? {
                    ...candidate,
                    status: "queued",
                    priority: "next",
                    requiresExplicitDispatch: true,
                    deliveryError: detail,
                  }
                : candidate
            )
          : [
              ...current,
              {
                ...message,
                status: "queued",
                priority: "next",
                requiresExplicitDispatch: true,
                deliveryError: detail,
              },
            ]
      );
      interruptRequestedByMessageIdRef.current.delete(message.id);
      Message.error({
        content: `Failed to send message: ${detail}`,
        duration: 5000,
      });
    },
    [store]
  );

  // One bounded wake-up owner for backend-busy and accepted-delivery retries.
  const wakeTimerRef = useRef<number | null>(null);
  const wakeAtRef = useRef<number | null>(null);
  const tryDispatchNextRef = useRef<() => void>(() => {});

  const scheduleWakeAt = useCallback((wakeAt: number) => {
    if (wakeAtRef.current !== null && wakeAtRef.current <= wakeAt) return;
    if (wakeTimerRef.current !== null) {
      window.clearTimeout(wakeTimerRef.current);
    }
    wakeAtRef.current = wakeAt;
    wakeTimerRef.current = window.setTimeout(
      () => {
        wakeTimerRef.current = null;
        wakeAtRef.current = null;
        tryDispatchNextRef.current();
      },
      Math.max(0, wakeAt - Date.now())
    );
  }, []);

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
        resolveSessionAgentExecMode(session?.agentExecMode);
      const { model, accountId } = resolveModelForMessage(lastModelSelection);

      // Capture the payload for Stop-restore before the async append.
      store.set(lastUserMessageAtom, {
        sessionId,
        displayContent,
        imageDataUrls,
      });

      void (async () => {
        try {
          // Pass displayContent as displayText when it differs from content
          // (i.e. skill pills were expanded) so the persisted event stores
          // the pill format and re-editing shows the pill, not the YAML.
          const displayTextForDispatch =
            content !== displayContent ? displayContent : undefined;
          await dispatchUserIntent({
            sessionId,
            visibleText: displayContent,
            imageDataUrls,
            runtimeStatusSource: "queue",
            queueMessageId: msg.id,
            send: {
              content,
              displayText: displayTextForDispatch,
              model,
              accountId,
              mode: agentExecMode,
              clientMessageId: `queued:${sessionId}:${msg.id}`,
              turnIntentId: msg.turnIntentId,
              turnIntentSource: msg.priority === "now" ? "force_send" : "queue",
              directUserIntent: true,
            },
          });
          acceptQueuedMessage(msg.id);
          onDone();
        } catch (err) {
          log.error("[useQueueDispatch] dispatch failed:", err);
          settleQueuedMessageFailure(msg, err);
          onDone();
        }
      })();
    },
    [acceptQueuedMessage, settleQueuedMessageFailure, store]
  );

  const activeDeliveryIdsRef = useRef<Set<string>>(new Set());

  const retryActiveDelivery = useCallback(
    async (delivery: ActiveMessageDelivery) => {
      const attempt = (delivery.retryAttempt ?? 0) + 1;
      await updateActiveMessageDelivery(store, delivery.id, {
        retryAttempt: attempt,
        retryAt: new Date(
          Date.now() + canonicalRecoveryDelayMs(attempt)
        ).toISOString(),
      });
    },
    [store]
  );

  const projectActiveCanonicalFailure = useCallback(
    async (
      delivery: ActiveMessageDelivery,
      error: unknown
    ): Promise<boolean> => {
      let projected = false;
      try {
        projected = await setOptimisticQueueUserDelivery(
          optimisticDeliveryProjectionParams(delivery),
          "failed",
          error
        );
      } catch (projectionError) {
        log.error(
          "[useQueueDispatch] could not fail canonical transcript row:",
          projectionError
        );
        return false;
      }
      return projected;
    },
    []
  );

  const returnFailedCanonicalDeliveryToQueue = useCallback(
    async (
      delivery: ActiveMessageDelivery,
      error?: unknown
    ): Promise<boolean> => {
      try {
        await returnActiveDeliveryToMessageQueue(
          store,
          delivery.id,
          queuedRetryFromDelivery(delivery, error)
        );
        return true;
      } catch (returnError) {
        log.error(
          "[useQueueDispatch] could not restore failed queue row:",
          returnError
        );
        const current = store
          .get(activeMessageDeliveriesAtom)
          .find((candidate) => candidate.id === delivery.id);
        if (current) await retryActiveDelivery(current);
        return false;
      }
    },
    [retryActiveDelivery, store]
  );

  const startRunnableActiveDeliveries = useCallback(() => {
    if (!store.get(messageQueueHydratedAtom)) return;
    if (!executeCanonicalConversation) return;
    const now = Date.now();
    const deliveries = store.get(activeMessageDeliveriesAtom);
    const ownerKey = messageQueueOwnerKeyRef.current;
    if (!ownerKey) return;
    const claimedRoots = new Set<string>();
    for (const delivery of deliveries) {
      if (!activeDeliveryIdsRef.current.has(delivery.id)) continue;
      claimedRoots.add(conversationRootKey(delivery.conversationDispatch.root));
    }
    const runnable = deliveries.filter((delivery) => {
      if (activeDeliveryIdsRef.current.has(delivery.id)) return false;
      if (
        !isPrimaryMessageQueueOwnerKey(ownerKey) &&
        delivery.originQueueKey !== ownerKey
      ) {
        return false;
      }
      const rootKey = conversationRootKey(delivery.conversationDispatch.root);
      if (claimedRoots.has(rootKey)) return false;
      // Claim the durable FIFO head before evaluating its wake condition.
      // A blocked/backing-off head must prevent a later turn for the same
      // canonical root from materializing against a transcript missing it.
      claimedRoots.add(rootKey);
      const retryAt = Date.parse(delivery.retryAt ?? "");
      if (Number.isFinite(retryAt) && retryAt > now) return false;
      return true;
    });
    const nextRetryAt = deliveries.reduce<number | undefined>(
      (earliest, delivery) => {
        const retryAt = Date.parse(delivery.retryAt ?? "");
        if (!Number.isFinite(retryAt) || retryAt <= now) return earliest;
        return earliest === undefined || retryAt < earliest
          ? retryAt
          : earliest;
      },
      undefined
    );
    if (nextRetryAt !== undefined) scheduleWakeAt(nextRetryAt);

    for (const delivery of runnable) {
      const deliveryId = delivery.id;
      activeDeliveryIdsRef.current.add(deliveryId);
      void withCanonicalConversationTurnLock(
        delivery.conversationDispatch.root,
        async () => {
          // The atom only wakes the dispatcher. The durable row read under the
          // root lock is the sole launch authority and carries the latest
          // accepted/runner recovery metadata from every webview.
          const currentDelivery =
            await assertDurableActiveDeliveryIsRootHead(deliveryId);
          let accepted = currentDelivery.status === "accepted";
          const message = currentDelivery;
          await executeCanonicalConversation(store, message, {
            onRunnerReady: async (runnerSessionId, runnerEventStartIndex) => {
              await updateActiveMessageDelivery(store, currentDelivery.id, {
                runnerSessionId,
                runnerEventStartIndex,
                retryAt: undefined,
              });
            },
            onAccepted: async (runnerSessionId) => {
              accepted = true;
              await updateActiveMessageDelivery(store, currentDelivery.id, {
                status: "accepted",
                runnerSessionId,
                retryAt: undefined,
              });
              await setOptimisticQueueUserDelivery(
                optimisticDeliveryProjectionParams(currentDelivery),
                "sent"
              ).catch((projectionError) => {
                log.error(
                  "[useQueueDispatch] could not accept canonical transcript row:",
                  projectionError
                );
                return false;
              });
            },
          })
            .then(async () => {
              await removeActiveMessageDelivery(store, currentDelivery.id);
            })
            .catch(async (error: unknown) => {
              if (error instanceof QueuedConversationRecoveryBlockedError) {
                if (!accepted) {
                  // A definitive pre-acceptance recovery verdict (for example,
                  // a restart-reconciled stale turn intent) is an ordinary
                  // failed send. Keep the user's row visible and retryable;
                  // only an already-accepted provider owner may be retired
                  // without returning it to the queue.
                  if (
                    !(await projectActiveCanonicalFailure(
                      currentDelivery,
                      error
                    ))
                  ) {
                    log.warn(
                      "[useQueueDispatch] failed recovery projection will be restored from delivery owner"
                    );
                  }
                  if (
                    !(await returnFailedCanonicalDeliveryToQueue(
                      currentDelivery,
                      error
                    ))
                  )
                    return;
                  Message.error({ content: error.message, duration: 5000 });
                  return;
                }
                // This typed verdict proves automatic recovery cannot run the
                // provider. Retire the execution owner without synthesizing a
                // retry of the already accepted intent; the durable provider/
                // Cloud failure row remains the visible terminal result.
                await removeActiveMessageDelivery(store, currentDelivery.id);
                Message.error({ content: error.message, duration: 5000 });
                return;
              }
              if (error instanceof QueuedConversationBlockedError) {
                if (accepted) {
                  // No adapter may demote an intent after the irreversible
                  // provider-acceptance boundary. Treat a late identity/account
                  // verdict as recovery work against the same native turn.
                  const current = store
                    .get(activeMessageDeliveriesAtom)
                    .find((candidate) => candidate.id === currentDelivery.id);
                  if (current) await retryActiveDelivery(current);
                  return;
                }
                // Admission failed before provider acceptance. The optimistic
                // EventStore row is already the visible retry/edit owner, so
                // fail that exact row rather than retracting it into a card.
                if (
                  !(await projectActiveCanonicalFailure(currentDelivery, error))
                ) {
                  log.warn(
                    "[useQueueDispatch] failed transcript projection will be restored from delivery owner"
                  );
                }
                if (
                  !(await returnFailedCanonicalDeliveryToQueue(
                    currentDelivery,
                    error
                  ))
                )
                  return;
                Message.error({
                  content: error.message,
                  duration: 5000,
                });
                return;
              }
              if (error instanceof QueuedConversationRecoveryPendingError) {
                // The canonical user event or provider acceptance boundary may
                // already be durable even when the result/tail cannot be read or
                // published yet. Keep this execution owner in place regardless
                // of its current phase and retry idempotent recovery only.
                log.error(
                  "[useQueueDispatch] canonical execution needs recovery:",
                  error
                );
                const current = store
                  .get(activeMessageDeliveriesAtom)
                  .find((candidate) => candidate.id === currentDelivery.id);
                if (current) await retryActiveDelivery(current);
                return;
              }
              if (error instanceof QueuedConversationTurnFailedError) {
                // The provider closed the accepted turn with a definitive
                // failure and no tail. The optimistic row is the visible retry
                // owner: fail it with the reason and hold it for an explicit
                // resend instead of reconnecting to a turn that cannot recover.
                if (
                  !(await projectActiveCanonicalFailure(currentDelivery, error))
                ) {
                  log.warn(
                    "[useQueueDispatch] failed transcript projection will be restored from delivery owner"
                  );
                }
                if (
                  !(await returnFailedCanonicalDeliveryToQueue(
                    currentDelivery,
                    error
                  ))
                )
                  return;
                Message.error({ content: error.message, duration: 5000 });
                return;
              }
              if (error instanceof QueuedConversationTurnClosedError) {
                // The Cloud plane already contains the human row and its terminal
                // failure result. Removing only the execution owner completes the
                // lifecycle; requeueing would create a duplicate provider turn.
                await projectActiveCanonicalFailure(currentDelivery, error);
                await removeActiveMessageDelivery(store, currentDelivery.id);
                return;
              }
              if (accepted) {
                // Acceptance is an irreversible boundary: the provider may have
                // executed tools even when recovery/tail staging later failed.
                // Retain this durable owner and reconnect to the SAME turn after a
                // bounded backoff. The adapter's accepted path is recovery-only;
                // it must never fall back to a fresh provider send.
                log.error(
                  "[useQueueDispatch] accepted canonical execution needs recovery:",
                  error
                );
                const current = store
                  .get(activeMessageDeliveriesAtom)
                  .find((candidate) => candidate.id === currentDelivery.id);
                if (!current) return;
                await retryActiveDelivery(current);
                return;
              }
              if (isUserIntentSendError(error)) {
                if (
                  !(await projectActiveCanonicalFailure(currentDelivery, error))
                )
                  log.warn(
                    "[useQueueDispatch] failed transcript projection will be restored from delivery owner"
                  );
                await returnFailedCanonicalDeliveryToQueue(
                  currentDelivery,
                  error
                );
                return;
              }
              if (
                !(await projectActiveCanonicalFailure(currentDelivery, error))
              )
                log.warn(
                  "[useQueueDispatch] failed transcript projection will be restored from delivery owner"
                );
              if (
                !(await returnFailedCanonicalDeliveryToQueue(
                  currentDelivery,
                  error
                ))
              )
                return;
              Message.error({
                content: `Failed to continue conversation: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                duration: 5000,
              });
            })
            .catch((settlementError: unknown) => {
              // A failed retry/remove/return write must not become an unhandled
              // rejection followed by an immediate provider retry loop. Keep the
              // durable owner projected locally with a bounded wake; focus/online
              // reconciliation will re-read the authoritative document sooner if
              // storage recovers.
              log.error(
                "[useQueueDispatch] canonical settlement persistence failed:",
                settlementError
              );
              const retryAt = new Date(
                Date.now() + QUEUE_BACKEND_RECHECK_MS
              ).toISOString();
              replaceActiveMessageDeliveryLocally(store, currentDelivery.id, {
                retryAt,
              });
            });
        }
      )
        .catch(async (lockError: unknown) => {
          if (lockError instanceof QueuedConversationBusyError) {
            await refreshMessageDeliveries(store);
            const current = store
              .get(activeMessageDeliveriesAtom)
              .find((candidate) => candidate.id === delivery.id);
            if (current) await retryActiveDelivery(current);
            return;
          }
          log.error(
            "[useQueueDispatch] canonical root lock/claim failed:",
            lockError
          );
          const retryAt = new Date(
            Date.now() + QUEUE_BACKEND_RECHECK_MS
          ).toISOString();
          replaceActiveMessageDeliveryLocally(store, delivery.id, { retryAt });
        })
        .finally(() => {
          activeDeliveryIdsRef.current.delete(delivery.id);
          tryDispatchNextRef.current();
        });
    }
  }, [
    executeCanonicalConversation,
    projectActiveCanonicalFailure,
    returnFailedCanonicalDeliveryToQueue,
    retryActiveDelivery,
    scheduleWakeAt,
    store,
  ]);

  const dispatchCanonicalMessage = useCallback(
    (msg: QueuedMessage, onDone: () => void) => {
      if (!msg.conversationDispatch) {
        onDone();
        return;
      }
      const delivery: ActiveMessageDelivery = {
        ...msg,
        conversationDispatch: msg.conversationDispatch,
        status: "preparing",
      };
      store.set(messageQueueHandoffIdsAtom, (current: ReadonlySet<string>) => {
        const next = new Set(current);
        next.add(msg.id);
        return next;
      });
      void persistDurableMessageQueue(store.get(messageQueueAtom))
        .then(() => handoffQueuedMessageToActiveDelivery(store, delivery))
        .then(() => {
          tryDispatchNextRef.current();
        })
        .catch((error) => settleQueuedMessageFailure(msg, error))
        .finally(() => {
          store.set(
            messageQueueHandoffIdsAtom,
            (current: ReadonlySet<string>) => {
              if (!current.has(msg.id)) return current;
              const next = new Set(current);
              next.delete(msg.id);
              return next;
            }
          );
          onDone();
        });
    },
    [settleQueuedMessageFailure, store]
  );

  const tryDispatchNext = useCallback(() => {
    if (!store.get(messageQueueHydratedAtom)) return;
    startRunnableActiveDeliveries();
    if (dispatchLockRef.current) return;
    if (store.get(queueEditingAtom)) return;

    const queue = store.get(messageQueueAtom);
    if (queue.length === 0) return;

    const candidates = queue.filter(
      (msg) => msg.id !== inFlightMessageIdRef.current
    );
    const activeCanonicalExecution = (message: QueuedMessage) => {
      const descriptor = message.conversationDispatch;
      if (!descriptor) return undefined;
      const rootKey = conversationRootKey(descriptor.root);
      return store
        .get(activeMessageDeliveriesAtom)
        .find(
          (delivery) =>
            conversationRootKey(delivery.conversationDispatch.root) === rootKey
        );
    };

    // ── Explicit "now" dispatches take absolute precedence per session ───────
    // A blocked Send Now for session A must not freeze an idle session B. Scan
    // every explicit candidate, dispatch the first idle one, and request at
    // most one interrupt for each active message while continuing the pass.
    const explicitMessages = candidates.filter((msg) => msg.priority === "now");
    for (const explicitMsg of explicitMessages) {
      const canonicalExecution = activeCanonicalExecution(explicitMsg);
      const canonicalRunnerSessionId = canonicalExecution?.runnerSessionId;
      const phase = explicitMsg.conversationDispatch
        ? canonicalRunnerSessionId
          ? getTurnPhase(canonicalRunnerSessionId)
          : canonicalExecution
            ? "dispatching"
            : getTurnPhase(explicitMsg.sessionId)
        : getTurnPhase(queuedMessageScopeKey(explicitMsg));
      // An execution row is the canonical root's accepted/recovery barrier.
      // Even when its concrete runner is already terminal, the next turn must
      // wait for tail publication and owner removal instead of racing recovery.
      if (phase === "idle" && !canonicalExecution) {
        // One shared admission/dispatch policy owns the Stop episode for both
        // ordinary Sessions and canonical runtime continuations.
        store.set(closePostStopDispatchEpisodeAtom, explicitMsg.sessionId);
        dispatchLockRef.current = true;
        inFlightMessageIdRef.current = explicitMsg.id;
        const dispatch = explicitMsg.conversationDispatch
          ? dispatchCanonicalMessage
          : dispatchMessage;
        dispatch(explicitMsg, () => {
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
        const interruptSessionId = explicitMsg.conversationDispatch
          ? canonicalExecution
            ? canonicalRunnerSessionId
            : explicitMsg.sessionId
          : explicitMsg.sessionId;
        // The canonical root may still be preparing its native Session. Until
        // onRunnerReady publishes an addressable Session there is nothing the
        // ordinary timeline-boundary interrupt can target.
        if (!interruptSessionId) continue;
        // Send Now against an active turn: interrupt it once. The provider's
        // cancelled terminal flips the FSM idle, which re-triggers this pass.
        interruptRequestedByMessageIdRef.current.add(explicitMsg.id);
        const interruptGeneration = getTurnGeneration(interruptSessionId);
        let interruptFailureHandled = false;
        const handleInterruptFailure = (detail: string) => {
          if (interruptFailureHandled) return;
          interruptFailureHandled = true;
          restoreTurnWorkingAfterInterruptFailure(interruptSessionId, {
            generation: interruptGeneration,
          });
          settleQueuedMessageFailure(explicitMsg, new Error(detail));
          log.warn("[useQueueDispatch] force-send interrupt failed:", detail);
        };
        void cancelTurnForTimelineBoundary(interruptSessionId, "force-send", {
          queueSessionId: explicitMsg.sessionId,
          onError: handleInterruptFailure,
        }).catch((error) => {
          handleInterruptFailure(
            error instanceof Error ? error.message : String(error)
          );
        });
      }
      // `stopping` and already-requested interrupts wait for their own
      // terminal, but do not block dispatchable work in another session.
    }

    // ── Natural FIFO drain ──────────────────────────────────────────────────
    // A Stop-held head is still the FIFO head. A definitive pre-acceptance
    // failure is different: its failed bubble remains independently
    // retryable/editable, but it never entered provider history and therefore
    // must not freeze later natural messages in the same scope.
    const naturalHeadIds = new Set<string>();
    const naturalScopes = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.priority === "now") continue;
      if (candidate.requiresExplicitDispatch && candidate.deliveryError)
        continue;
      const scopeKey = queuedMessageScopeKey(candidate);
      if (naturalScopes.has(scopeKey)) continue;
      naturalScopes.add(scopeKey);
      naturalHeadIds.add(candidate.id);
    }
    for (const msg of candidates) {
      if (msg.priority === "now") continue;
      if (!naturalHeadIds.has(msg.id)) continue;
      if (msg.requiresExplicitDispatch) continue; // held by a user Stop
      if (msg.conversationDispatch) {
        if (activeCanonicalExecution(msg)) continue;
        // Before the queue owns a canonical execution, the visible/source
        // Session may still be running its initial or preceding native turn.
        // Reuse the ordinary concrete-session FSM gate instead of treating the
        // absence of an execution receipt as proof that the root is idle.
        if (getTurnPhase(msg.sessionId) !== "idle") continue;
        dispatchLockRef.current = true;
        inFlightMessageIdRef.current = msg.id;
        dispatchCanonicalMessage(msg, () => {
          if (inFlightMessageIdRef.current === msg.id) {
            inFlightMessageIdRef.current = null;
          }
          dispatchLockRef.current = false;
          tryDispatchNextRef.current();
        });
        return;
      }
      const scopeKey = queuedMessageScopeKey(msg);
      if (getTurnPhase(scopeKey) !== "idle") continue; // turn active
      dispatchLockRef.current = true;
      inFlightMessageIdRef.current = msg.id;
      // Authoritative gate: the FSM can be forced idle without a real
      // provider terminal (watchdog / dead-man / rewind). Confirm with the
      // backend before injecting a natural follow-up into the session.
      void getBackendDispatchVerdict(msg.sessionId).then((verdict) => {
        if (inFlightMessageIdRef.current !== msg.id) return;
        if (verdict === "busy" || verdict === "unknown") {
          // Still executing or backend state is unknown — back off and
          // re-check. Never infer idle from a failed status read.
          inFlightMessageIdRef.current = null;
          dispatchLockRef.current = false;
          scheduleWakeAt(Date.now() + QUEUE_BACKEND_RECHECK_MS);
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
  }, [
    dispatchCanonicalMessage,
    dispatchMessage,
    scheduleWakeAt,
    settleQueuedMessageFailure,
    startRunnableActiveDeliveries,
    store,
  ]);

  useEffect(() => {
    tryDispatchNextRef.current = tryDispatchNext;
  }, [tryDispatchNext]);

  useEffect(() => {
    const unsubscribe = store.sub(queueDispatchSyncInputsAtom, tryDispatchNext);
    tryDispatchNext();
    return () => {
      unsubscribe();
      if (wakeTimerRef.current !== null) {
        window.clearTimeout(wakeTimerRef.current);
        wakeTimerRef.current = null;
        wakeAtRef.current = null;
      }
    };
  }, [store, tryDispatchNext]);
}
