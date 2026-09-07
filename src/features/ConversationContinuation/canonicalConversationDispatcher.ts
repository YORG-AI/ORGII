import type { Store } from "jotai/vanilla/store";

import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { rpc } from "@src/api/tauri/rpc";
import type { ConversationRootLocator } from "@src/engines/SessionCore/conversations/conversationTypes";
import {
  type ContinueLocalConversationResult,
  continueLocalConversationAfterTimelineLoad,
  localConversationRootForSession,
  recoverLocalConversationTurn,
} from "@src/engines/SessionCore/conversations/localConversationContinuation";
import { loadLocalCanonicalConversationTimeline } from "@src/engines/SessionCore/conversations/localConversationExecutionTail";
import type {
  QueuedConversationDispatcher,
  QueuedConversationExecutionMessage,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import {
  QueuedConversationBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnFailedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { cloudConversationAuthorityIsLive } from "@src/features/Org2Cloud/SessionConversation/cloudConversationAuthority";
import { dispatchQueuedCloudConversation } from "@src/features/Org2Cloud/SessionConversation/cloudConversationQueueAdapter";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { Session } from "@src/store/session";
import { sessionsAtom } from "@src/store/session";

import { resolveExternalHistoryContinuation } from "./externalHistoryContinuation";

function sessionById(store: Store, sessionId: string): Session | undefined {
  return store
    .get(sessionsAtom)
    .find((candidate) => candidate.session_id === sessionId);
}

async function dispatchQueuedLocalConversation(
  store: Store,
  message: QueuedConversationExecutionMessage,
  callbacks: Parameters<QueuedConversationDispatcher>[2]
): Promise<void> {
  const descriptor = message.conversationDispatch;
  if (!descriptor) throw new Error("canonical conversation target is missing");
  const { root } = descriptor;
  let { target } = descriptor;
  const sourceSession = sessionById(store, message.sessionId);
  let title = sourceSession?.name ?? "Conversation";
  if (getImportedHistorySourceBySessionId(message.sessionId)) {
    const resolved = await resolveExternalHistoryContinuation({
      sourceSessionId: message.sessionId,
      sourceSession,
      target,
    });
    target = resolved.target;
    title = resolved.title;
  }

  if (
    root.authority !== "local-session" &&
    root.authority !== "imported-history"
  ) {
    throw new Error(
      `unsupported local conversation authority: ${root.authority}`
    );
  }
  let runnerReady = false;
  let providerAccepted = message.status === "accepted";
  const announceRunner = async (
    sessionId: string,
    eventStartIndex: number
  ): Promise<void> => {
    runnerReady = true;
    try {
      await callbacks.onRunnerReady?.(sessionId, eventStartIndex);
    } catch (error) {
      // The native child already exists at this boundary. Keep the global
      // execution owner so the same turn can reconnect to that child; treating
      // this as an ordinary send failure would create another native episode.
      throw new QueuedConversationRecoveryPendingError(
        `runner ${sessionId} recovery receipt could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  };
  const continuationParams = {
    root,
    title,
    // Local/imported roots accumulate durable provider-native execution
    // episodes. Read the verified child suffixes as part of the same canonical
    // timeline instead of repeatedly rebuilding from the original source only.
    loadTimeline: () => loadLocalCanonicalConversationTimeline(root),
    displayText: message.displayContent,
    agentContent: message.content,
    imageDataUrls: message.imageDataUrls,
    target,
    turnIntentId: message.turnIntentId,
    onSessionPreparing: (sessionId: string) =>
      announceRunner(sessionId, Number.MAX_SAFE_INTEGER),
    onSessionReady: announceRunner,
    onTurnAccepted: async (sessionId: string) => {
      providerAccepted = true;
      await callbacks.onAccepted(sessionId);
    },
  };
  const settleTerminal = async (
    result: ContinueLocalConversationResult | null | undefined
  ) => {
    if (
      !result ||
      result.terminalStatus !== "failed" ||
      result.agentTail.length > 0
    ) {
      return;
    }
    // The provider accepted the turn and then rejected it outright (for
    // example a model the account cannot use). Nothing landed on the root,
    // so the user's row must carry the reason and stay retryable instead of
    // sitting under "Agent is idle" as if it had been answered.
    throw new QueuedConversationTurnFailedError(
      await localTurnFailureReason(store, result.sessionId)
    );
  };
  if (message.runnerSessionId) {
    const recovered = await recoverLocalConversationTurn({
      ...continuationParams,
      timeline: await continuationParams.loadTimeline(),
      runnerSessionId: message.runnerSessionId,
      eventStartIndex: message.runnerEventStartIndex,
    });
    if (recovered) {
      await settleTerminal(recovered);
      return;
    }
    if (message.status === "accepted") {
      throw new QueuedConversationRecoveryPendingError();
    }
  }
  let result: ContinueLocalConversationResult | undefined;
  try {
    result =
      await continueLocalConversationAfterTimelineLoad(continuationParams);
  } catch (error) {
    if (
      error instanceof QueuedConversationRecoveryPendingError &&
      !runnerReady &&
      !providerAccepted
    ) {
      // Candidate/source inspection happens before a visible native runner or
      // provider boundary. Keep the user's intent visible in the existing
      // held queue instead of hiding it behind an execution retry loop.
      throw new QueuedConversationBlockedError(error.message);
    }
    throw error;
  }
  await settleTerminal(result);
}

const DEFAULT_LOCAL_TURN_FAILURE = "Agent request failed";

async function localTurnFailureReason(
  store: Store,
  runnerSessionId: string
): Promise<string> {
  const fromStore = sessionById(store, runnerSessionId)?.error_message?.trim();
  const raw =
    fromStore ||
    (await rpc.cli
      .status({ sessionId: runnerSessionId })
      .then((stored) =>
        (
          stored as { errorMessage?: string | null } | null
        )?.errorMessage?.trim()
      )
      .catch(() => undefined));
  if (!raw) return DEFAULT_LOCAL_TURN_FAILURE;
  return parseFailureReason(raw);
}

function parseFailureReason(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const nested = (parsed as { error?: { message?: unknown } }).error;
      if (nested && typeof nested.message === "string" && nested.message) {
        return nested.message;
      }
      const direct = (parsed as { message?: unknown }).message;
      if (typeof direct === "string" && direct) return direct;
    }
  } catch {
    // Not JSON: the stored text is already the human-readable reason.
  }
  return raw;
}

/**
 * A durable Cloud-rooted turn may outlive its Cloud plane: the owner-local
 * session was shared, the org's replay retention expired that copy, and the
 * root row left the listing for good. The binding already continues such a
 * session locally for new sends; a retained or retried queue row must follow
 * the same verdict instead of asking the Cloud plane to admit it again.
 */
export function resolveQueuedConversationRoot(
  store: Store,
  message: QueuedConversationExecutionMessage,
  root: ConversationRootLocator
): ConversationRootLocator {
  if (root.authority !== "org2-cloud") return root;
  const [first, second] = root.authorityScope;
  const orgId = second ?? first;
  if (!orgId || message.status === "accepted") return root;
  const session = sessionById(store, message.sessionId);
  if (
    !session ||
    session.session_id !== root.conversationId ||
    cloudConversationAuthorityIsLive({
      session,
      target: { orgId, sessionId: root.conversationId },
      entry: store.get(org2CloudRemoteSessionsAtom)[orgId],
      loadingSource: undefined,
    })
  ) {
    return root;
  }
  return (
    localConversationRootForSession(
      session.session_id,
      session.cliAgentType,
      session.agentDefinitionId
    ) ?? root
  );
}

/** The sole canonical executor injected into SessionCore's existing queue. */
export const dispatchQueuedCanonicalConversation: QueuedConversationDispatcher =
  async (store, message, callbacks) => {
    const descriptor = message.conversationDispatch;
    if (!descriptor || descriptor.kind !== "canonical_conversation") {
      throw new Error("queued message is not a canonical conversation turn");
    }
    const root = resolveQueuedConversationRoot(store, message, descriptor.root);
    if (root.authority === "org2-cloud") {
      return await dispatchQueuedCloudConversation(
        store,
        message,
        root,
        callbacks
      );
    }
    return await dispatchQueuedLocalConversation(
      store,
      root === descriptor.root
        ? message
        : { ...message, conversationDispatch: { ...descriptor, root } },
      callbacks
    );
  };
