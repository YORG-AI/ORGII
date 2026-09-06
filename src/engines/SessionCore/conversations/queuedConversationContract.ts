import type { Store } from "jotai/vanilla/store";

import {
  ConversationRootLocator,
  LocalConversationTarget,
  isConversationRootLocator,
  isLocalConversationTarget,
} from "./conversationTypes";

export interface QueuedConversationDispatch {
  kind: "canonical_conversation";
  /** Typed provider-neutral identity; all native execution episodes share it. */
  root: ConversationRootLocator;
  /** Runtime/account/model/workspace frozen when the user pressed Send. */
  target: LocalConversationTarget;
  /** Non-secret sender/account identity frozen at admission for remote roots. */
  dispatchIdentityKey?: string;
}

/** Neutral subset consumed by a canonical authority executor. */
export interface QueuedConversationMessage {
  id: string;
  turnIntentId: string;
  sessionId: string;
  content: string;
  displayContent: string;
  imageDataUrls?: string[];
  conversationDispatch?: QueuedConversationDispatch;
}

export interface QueuedConversationExecutionMessage extends QueuedConversationMessage {
  status: "preparing" | "accepted";
  runnerSessionId?: string;
  runnerEventStartIndex?: number;
}

export const MAX_QUEUED_CONVERSATION_MESSAGE_CHARS = 8 * 1024 * 1024;
export const MAX_QUEUED_CONVERSATION_MESSAGE_CHARS_TOTAL = 32 * 1024 * 1024;

export function queuedConversationMessageCharSize(
  message: Pick<
    QueuedConversationMessage,
    "content" | "displayContent" | "imageDataUrls"
  >
): number {
  return (
    message.content.length +
    message.displayContent.length +
    (message.imageDataUrls ?? []).reduce(
      (total, image) => total + image.length,
      0
    )
  );
}

/** Shared persisted-payload schema for the UI queue and execution owner. */
export function isQueuedConversationMessagePayload(
  value: unknown
): value is QueuedConversationMessage {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<QueuedConversationMessage>;
  const dispatch = item.conversationDispatch;
  return Boolean(
    typeof item.id === "string" &&
    typeof item.turnIntentId === "string" &&
    typeof item.sessionId === "string" &&
    typeof item.content === "string" &&
    typeof item.displayContent === "string" &&
    (item.imageDataUrls === undefined ||
      (Array.isArray(item.imageDataUrls) &&
        item.imageDataUrls.every((image) => typeof image === "string"))) &&
    dispatch?.kind === "canonical_conversation" &&
    isConversationRootLocator(dispatch.root) &&
    isLocalConversationTarget(dispatch.target) &&
    (dispatch.dispatchIdentityKey === undefined ||
      typeof dispatch.dispatchIdentityKey === "string") &&
    queuedConversationMessageCharSize(item as QueuedConversationMessage) <=
      MAX_QUEUED_CONVERSATION_MESSAGE_CHARS
  );
}

/** Lifecycle boundaries exposed by the existing durable message queue. */
export interface QueuedConversationDispatchCallbacks {
  /** Provider accepted the turn; persist `accepted` on the same queue row. */
  onAccepted: (runnerSessionId: string) => void | Promise<void>;
  /** A writable native execution episode is ready for presentation. */
  onRunnerReady?: (
    runnerSessionId: string,
    eventStartIndex: number
  ) => void | Promise<void>;
}

/** Another window currently owns this canonical root; keep the row queued. */
export class QueuedConversationBusyError extends Error {
  constructor() {
    super("canonical conversation is running in another window");
    this.name = "QueuedConversationBusyError";
  }
}

/** The durable row is valid but cannot run under the current local identity. */
export class QueuedConversationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuedConversationBlockedError";
  }
}

/** An accepted provider turn is not readable yet; retry recovery, never send. */
export class QueuedConversationRecoveryPendingError extends Error {
  constructor(message = "accepted conversation turn is not recoverable yet") {
    super(message);
    this.name = "QueuedConversationRecoveryPendingError";
  }
}

/** Accepted native state contradicts the canonical root and needs inspection. */
export class QueuedConversationRecoveryBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuedConversationRecoveryBlockedError";
  }
}

/**
 * The provider accepted the turn and then failed it definitively without
 * producing a tail. Keep the user's row visible with the reason and hold it
 * for an explicit retry; never rerun the provider on its own.
 */
export class QueuedConversationTurnFailedError extends Error {
  constructor(message = "conversation turn failed") {
    super(message);
    this.name = "QueuedConversationTurnFailedError";
  }
}

/** The canonical user turn has a durable terminal failure; do not requeue it. */
export class QueuedConversationTurnClosedError extends Error {
  constructor(message = "canonical conversation turn is already closed") {
    super(message);
    this.name = "QueuedConversationTurnClosedError";
  }
}

/**
 * Dependency-inversion seam for canonical-conversation delivery.
 *
 * This is a contract, not a queue or executor owner. SessionCore continues to
 * own the only durable queue; feature composition supplies a dispatcher
 * without making the queue depend on UI or Cloud modules.
 */
export type QueuedConversationDispatcher = (
  store: Store,
  message: QueuedConversationExecutionMessage,
  callbacks: QueuedConversationDispatchCallbacks
) => Promise<void>;
