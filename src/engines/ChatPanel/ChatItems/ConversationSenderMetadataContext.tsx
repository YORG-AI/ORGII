import { createContext, useContext } from "react";

import {
  CONVERSATION_VIEWER_SIGNED_OUT,
  type ConversationSenderIdentity,
  type ConversationSenderRelationship,
  type ConversationSenderStamp,
  type ConversationViewerState,
  conversationSenderStampOf,
  resolveConversationSenderRelationship,
} from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

interface ConversationSenderMetadataContextValue {
  viewer: ConversationViewerState;
  /**
   * Enrich a validated event stamp or provide source-owner presentation for
   * inherited unstamped rows. Returning an identity never changes row side;
   * only a stable event stamp can establish viewer/other ownership.
   */
  resolveSender: (
    event: SessionEvent,
    stampedSender: ConversationSenderStamp | null
  ) => ConversationSenderIdentity | null;
}

const ConversationSenderMetadataContext =
  createContext<ConversationSenderMetadataContextValue | null>(null);

export const ConversationSenderMetadataProvider =
  ConversationSenderMetadataContext.Provider;

export interface ConversationSenderResolution {
  identity: ConversationSenderIdentity | null;
  relationship: ConversationSenderRelationship;
}

/** Resolve one row without importing any transport/account implementation. */
export function useConversationSenderResolution(
  event: SessionEvent | undefined
): ConversationSenderResolution {
  const context = useContext(ConversationSenderMetadataContext);
  const stampedSender = conversationSenderStampOf(event);
  const identity = event
    ? context
      ? context.resolveSender(event, stampedSender)
      : stampedSender
    : null;
  const relationship = resolveConversationSenderRelationship(
    stampedSender,
    context?.viewer ?? CONVERSATION_VIEWER_SIGNED_OUT
  );
  return { identity, relationship };
}
