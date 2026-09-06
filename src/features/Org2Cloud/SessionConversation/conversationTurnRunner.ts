/**
 * Cloud-plane adapter for the provider-neutral local continuation core.
 *
 * Cloud stores and orders canonical events; it never executes an Agent and
 * never receives a local credential. The current local app selects one of its
 * own runtimes, continues a normal persisted child Session, and publishes only
 * that turn's normalized tail back to the shared plane.
 */
import type { TurnTerminalStatus } from "@src/engines/SessionCore/control/turnLifecycle";
import {
  CONVERSATION_TURN_ID_ARG,
  type ConversationRootLocator,
  type LocalConversationTarget,
  continueLocalConversation,
  recoverLocalConversationTurn,
} from "@src/engines/SessionCore/conversations/localConversationContinuation";
import {
  QueuedConversationRecoveryBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnClosedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";

import { conversationEventsForPush } from "../org2CloudConversationEventsClient";
import { isRetryableCloudRequestError } from "../org2CloudFetchRetry";

const log = createLogger("ConversationTurnRunner");

export function buildPushedUserEvent(
  displayText: string,
  agentContent: string | undefined,
  imageDataUrls: readonly string[] | undefined,
  createdAt: string,
  turnIntentId: string
): SessionEvent {
  const id = `convturn-user-${turnIntentId}`;
  return {
    id,
    chunk_id: id,
    sessionId: "conversation",
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: { [CONVERSATION_TURN_ID_ARG]: turnIntentId },
    result: {
      type: "user",
      message: { content: agentContent ?? displayText, role: "user" },
      ...(imageDataUrls && imageDataUrls.length > 0
        ? { images: [...imageDataUrls] }
        : {}),
      turnIntentId,
    },
    source: "user",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

function buildPushedDispatchFailureEvent(
  error: unknown,
  createdAt: string,
  turnIntentId: string
): SessionEvent {
  const id = `convturn-error-${turnIntentId}`;
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "Agent request failed";
  return {
    id,
    chunk_id: id,
    sessionId: "conversation",
    createdAt,
    functionName: "error",
    uiCanonical: "error",
    actionType: "error",
    args: { [CONVERSATION_TURN_ID_ARG]: turnIntentId },
    result: { error: message, success: false, turnIntentId },
    // A system error renders through the existing AgentErrorChatItem but is
    // deliberately absent from provider-native role/tool materialization.
    source: "system",
    displayText: message,
    displayStatus: "failed",
    displayVariant: "error",
    activityStatus: "processed",
    payloadRefs: [],
  } as SessionEvent;
}

interface RunConversationTurnParams {
  root: ConversationRootLocator;
  conversationTitle: string;
  displayText: string;
  agentContent?: string;
  imageDataUrls?: string[];
  /** Canonical merged transcript immediately before this turn. */
  timeline: readonly SessionEvent[];
  /** Composer-selected local runtime/account/model. Never resolved by a modal. */
  target: LocalConversationTarget;
  turnIntentId: string;
  recovery?: {
    runnerSessionId: string;
    eventStartIndex?: number;
    providerAccepted: boolean;
  };
  onRunnerReady?: (
    sessionId: string,
    turnId: string,
    eventStartIndex: number
  ) => void | Promise<void>;
  /** Cloud lease acceptance, immediately before provider dispatch. */
  onBeforeTurnDispatch?: (sessionId: string) => void | Promise<void>;
  /** Local provider accepted the turn; distinct from Cloud user publication. */
  onTurnAccepted?: (sessionId: string) => void | Promise<void>;
  /** Idempotently publish the normalized provider tail to the Cloud plane. */
  publishTail: (turnId: string, events: SessionEvent[]) => Promise<void>;
}

interface RunConversationTurnResult {
  runnerSessionId: string;
  terminalStatus: TurnTerminalStatus;
}

interface CloseConversationTurnWithFailureParams {
  rootLabel: string;
  error: unknown;
  turnIntentId: string;
  publishTail: (turnId: string, events: SessionEvent[]) => Promise<void>;
}

/**
 * The one Cloud terminal-failure boundary used before and during provider
 * execution. The event id is stable per turn, so retrying an ambiguous
 * publication cannot create a second visible error row.
 */
export async function closeConversationTurnWithFailure(
  params: CloseConversationTurnWithFailureParams
): Promise<never> {
  try {
    const failureEvents = await conversationEventsForPush(
      buildPushedDispatchFailureEvent(
        params.error,
        new Date().toISOString(),
        params.turnIntentId
      )
    );
    await params.publishTail(params.turnIntentId, failureEvents);
  } catch (publishError) {
    log.warn(
      `failed to publish execution error for ${params.rootLabel}`,
      publishError
    );
    if (
      publishError instanceof QueuedConversationRecoveryPendingError ||
      isRetryableCloudRequestError(publishError)
    ) {
      // The canonical user event already exists, so removing this execution
      // owner on an ambiguous publication would strand a pending turn. The
      // same idempotent terminal event is retried without running a provider.
      throw new QueuedConversationRecoveryPendingError(
        "conversation failure result could not be published yet"
      );
    }
    // A definitive 4xx/validation rejection cannot become successful by
    // retaining a forever-retrying owner. The failed publication was recorded
    // in the local log and this exact durable turn is now terminal.
  }
  throw new QueuedConversationTurnClosedError(
    params.error instanceof Error ? params.error.message : String(params.error)
  );
}

export async function runConversationTurn(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {
  const turnIntentId = params.turnIntentId;
  const root = params.root;
  const rootLabel = `${root.authority}:${root.conversationId}`;
  log.info(
    `resolved execution for ${rootLabel}; ` +
      `selected=${params.target.cliAgentType ?? "native"}`
  );

  let result: Awaited<ReturnType<typeof continueLocalConversation>>;
  let providerAccepted = params.recovery?.providerAccepted === true;
  try {
    const continuationParams = {
      root,
      title: params.conversationTitle,
      timeline: params.timeline,
      displayText: params.displayText,
      agentContent: params.agentContent,
      imageDataUrls: params.imageDataUrls,
      target: params.target,
      turnIntentId,
      // Bind the root surface to the hidden execution immediately. The
      // maximum prefix suppresses history overlay until materialization
      // reports the exact native boundary through onSessionReady below.
      onSessionPreparing: (sessionId: string) =>
        params.onRunnerReady?.(
          sessionId,
          turnIntentId,
          Number.MAX_SAFE_INTEGER
        ),
      onSessionReady: (sessionId: string, eventStartIndex: number) =>
        params.onRunnerReady?.(sessionId, turnIntentId, eventStartIndex),
      onBeforeTurnDispatch: params.onBeforeTurnDispatch,
      onTurnAccepted: async (sessionId: string) => {
        providerAccepted = true;
        await params.onTurnAccepted?.(sessionId);
      },
    };
    const recovered = params.recovery
      ? await recoverLocalConversationTurn({
          ...continuationParams,
          runnerSessionId: params.recovery.runnerSessionId,
          eventStartIndex: params.recovery.eventStartIndex,
        })
      : null;
    if (!recovered && params.recovery?.providerAccepted) {
      throw new QueuedConversationRecoveryPendingError();
    }
    result = recovered ?? (await continueLocalConversation(continuationParams));
  } catch (error) {
    // Discovery, materialization and accepted-turn reconciliation can fail
    // transiently. Keep the same durable execution owner and retry it; never
    // convert a recovery-pending verdict into a permanent Cloud error row.
    if (error instanceof QueuedConversationRecoveryPendingError) throw error;
    // The human message is already a successful Cloud-plane event. If the
    // local runtime then fails during create/materialize/send, publish one
    // ordinary transcript error beside it; otherwise the shared root looks
    // permanently unanswered after its transient runner overlay disappears.
    if (
      providerAccepted &&
      !(error instanceof QueuedConversationRecoveryBlockedError)
    ) {
      throw error;
    }
    return closeConversationTurnWithFailure({
      rootLabel,
      error,
      turnIntentId,
      publishTail: params.publishTail,
    });
  }

  const terminalTail =
    result.terminalStatus === "failed" && result.agentTail.length === 0
      ? [
          buildPushedDispatchFailureEvent(
            new Error("Agent request failed"),
            new Date().toISOString(),
            turnIntentId
          ),
        ]
      : result.agentTail;
  const agentTail = (
    await Promise.all(terminalTail.map(conversationEventsForPush))
  ).flat();
  if (agentTail.length > 0) {
    // The accepted canonical execution row remains the only crash-recovery
    // owner until this idempotent publish succeeds. A retry reconnects to the
    // same native turn and re-reads its tail; it never runs the provider twice.
    await params.publishTail(turnIntentId, agentTail);
  }
  log.info(
    `continued ${rootLabel} in ${result.sessionId}; ` +
      `staged ${agentTail.length} agent event(s)`
  );
  return {
    runnerSessionId: result.sessionId,
    terminalStatus: result.terminalStatus,
  };
}
