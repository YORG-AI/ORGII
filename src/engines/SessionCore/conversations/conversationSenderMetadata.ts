import { z } from "zod/v4";

import type { SessionEvent } from "../core/types";

/**
 * Provider-neutral event metadata for a human-authored conversation row.
 *
 * The string is intentionally kept wire-compatible with conversation events
 * already persisted by ORG2 Cloud. Providers may stamp this key, while the
 * generic transcript only knows how to validate and render its contents.
 */
export const CONVERSATION_SENDER_ARG = "conversationSender";

export const ConversationSenderStampSchema = z
  .object({
    userId: z.string().trim().min(1),
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .transform(({ userId, displayName, avatarUrl }) => {
    const normalizedDisplayName = displayName?.trim();
    const normalizedAvatarUrl = avatarUrl?.trim();
    return {
      userId,
      ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
      ...(normalizedAvatarUrl ? { avatarUrl: normalizedAvatarUrl } : {}),
    };
  });

/** Stable event stamp. `userId` is required so viewer ownership is exact. */
export type ConversationSenderStamp = z.output<
  typeof ConversationSenderStampSchema
>;

/**
 * Display identity after a composition layer enriches a stamp. Imported
 * pre-lineage history may know only a name/avatar, so `userId` is optional
 * here even though it is mandatory on newly stamped events.
 */
export interface ConversationSenderIdentity {
  userId?: string;
  displayName?: string;
  avatarUrl?: string;
}

/**
 * Provider-neutral viewer identity lifecycle.
 *
 * `loading` is deliberately distinct from `signed_out`: while persisted auth
 * is hydrating, a stamped local twin must keep its existing local/remote side
 * instead of being reclassified as somebody else's message.
 */
export type ConversationViewerState =
  | { status: "loading" }
  | { status: "known"; userId: string }
  | { status: "signed_out" };

export const CONVERSATION_VIEWER_LOADING: ConversationViewerState = {
  status: "loading",
};
export const CONVERSATION_VIEWER_SIGNED_OUT: ConversationViewerState = {
  status: "signed_out",
};

export type ConversationSenderRelationship =
  | "viewer"
  | "other"
  | "unresolved"
  | "unstamped";

/** Build the viewer state without conflating a pre-hydration null with logout. */
export function resolveConversationViewerState(
  viewerUserId: string | null | undefined,
  hydrationComplete: boolean
): ConversationViewerState {
  const userId = viewerUserId?.trim();
  if (userId) return { status: "known", userId };
  return hydrationComplete
    ? CONVERSATION_VIEWER_SIGNED_OUT
    : CONVERSATION_VIEWER_LOADING;
}

/** Compare a durable sender stamp only when viewer ownership is knowable. */
export function resolveConversationSenderRelationship(
  stampedSender: ConversationSenderStamp | null,
  viewer: ConversationViewerState
): ConversationSenderRelationship {
  if (!stampedSender) return "unstamped";
  if (viewer.status === "loading") return "unresolved";
  if (viewer.status === "signed_out") return "other";
  return stampedSender.userId === viewer.userId ? "viewer" : "other";
}

/** Read a sender stamp without trusting provider or persisted event payloads. */
export function conversationSenderStampOf(
  event: Pick<SessionEvent, "args"> | undefined
): ConversationSenderStamp | null {
  const parsed = ConversationSenderStampSchema.safeParse(
    event?.args?.[CONVERSATION_SENDER_ARG]
  );
  return parsed.success ? parsed.data : null;
}
