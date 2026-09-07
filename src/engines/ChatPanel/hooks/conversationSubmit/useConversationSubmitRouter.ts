import { useStore } from "jotai";
import { useCallback } from "react";

import { useUserIntentSubmit } from "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit";
import type {
  ConversationRootLocator,
  LocalConversationTarget,
} from "@src/engines/SessionCore/conversations/conversationTypes";
import type { QueuedConversationDispatch } from "@src/engines/SessionCore/conversations/queuedConversationContract";
import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { useCloudSessionDownloadProgressEntry } from "@src/features/Org2Cloud/useCloudSessionDownloadSurface";
import type { Session } from "@src/store/session";

import { isImportedSessionSubmitBlocked } from "../importedSessionSubmitReadiness";
import {
  type SubmitOverrideInput,
  SubmitValidationError,
} from "../useInputArea/types";

interface UseConversationSubmitRouterOptions {
  sessionId: string;
  currentSession: Session | undefined;
  root: ConversationRootLocator | null;
  selectedTarget: LocalConversationTarget | null;
  /** Existing human/team-chat routing always gets first refusal. */
  onSurfaceSubmit: (input: SubmitOverrideInput) => Promise<boolean>;
}

interface CanonicalConversationRetryInput extends SubmitOverrideInput {
  turnIntentId?: string;
}

interface ConversationSubmitRouter {
  submit: (input: SubmitOverrideInput) => Promise<boolean>;
  /** Retry a failed Agent turn without routing it through Team Chat. */
  retry: (input: CanonicalConversationRetryInput) => Promise<boolean>;
  /**
   * The canonical dispatch a retry of a held row should carry now: the
   * current root and the runtime the picker shows, not the pair the row was
   * admitted with. Null while no canonical runtime is selected.
   */
  resolveDispatch: () => QueuedConversationDispatch | null;
}

export function buildCanonicalConversationDispatch(params: {
  root: ConversationRootLocator | null;
  selectedTarget: Parameters<typeof canonicalConversationTargetOrThrow>[1];
  auth: Org2CloudAuthState | null;
}): QueuedConversationDispatch | null {
  const { root, selectedTarget, auth } = params;
  if (!root) return null;
  let target: ReturnType<typeof canonicalConversationTargetOrThrow>;
  try {
    target = canonicalConversationTargetOrThrow(root, selectedTarget);
  } catch {
    return null;
  }
  if (!target) return null;
  if (root.authority === "org2-cloud") {
    if (!auth) return null;
    return {
      kind: "canonical_conversation",
      root,
      target,
      dispatchIdentityKey: org2CloudAuthIdentityKey(auth),
    };
  }
  return { kind: "canonical_conversation", root, target };
}

/**
 * Distinguish an ordinary Session (no canonical root) from a canonical
 * conversation whose runtime inventory is still loading or unavailable.
 * Only the former may fall through to the legacy direct-session dispatcher.
 */
export function canonicalConversationTargetOrThrow(
  root: ConversationRootLocator | null,
  target: LocalConversationTarget | null
): LocalConversationTarget | null {
  if (!root) return null;
  if (!target) {
    throw new SubmitValidationError(
      "Select an available runtime before continuing this conversation"
    );
  }
  if (
    target.cliAgentType &&
    (target.cliAgentType !== "claude_code" || target.accountId) &&
    (!target.accountId || !target.model)
  ) {
    throw new SubmitValidationError(
      "Select a model and source before continuing this conversation"
    );
  }
  return target;
}

/**
 * Thin admission edge for canonical conversations.
 *
 * It does not execute providers, fork sessions, restore drafts, or maintain a
 * second queue. Human/team-chat routing remains the existing surface concern;
 * every Agent continuation is admitted into SessionCore's durable queue.
 */
export function useConversationSubmitRouter({
  sessionId,
  currentSession,
  root,
  selectedTarget,
  onSurfaceSubmit,
}: UseConversationSubmitRouterOptions): ConversationSubmitRouter {
  const store = useStore();
  const downloadProgress = useCloudSessionDownloadProgressEntry(sessionId);
  const submitUserIntent = useUserIntentSubmit({
    getSessionId: () => sessionId,
  });

  const enqueueCanonical = useCallback(
    async (input: CanonicalConversationRetryInput) => {
      if (
        isImportedSessionSubmitBlocked({
          sessionId,
          session: currentSession,
          progress: downloadProgress,
        })
      ) {
        throw new SubmitValidationError(
          "Wait for the shared session to finish loading before continuing"
        );
      }

      const target = canonicalConversationTargetOrThrow(root, selectedTarget);
      if (!root || !target) return false;

      let dispatchIdentityKey: string | undefined;
      if (root.authority === "org2-cloud") {
        const auth = store.get(org2CloudAuthAtom);
        if (!auth) {
          throw new SubmitValidationError(
            "Cloud sign-in is required before queuing this turn"
          );
        }
        dispatchIdentityKey = org2CloudAuthIdentityKey(auth);
      }
      const conversationDispatch: QueuedConversationDispatch = {
        kind: "canonical_conversation",
        root,
        target,
        ...(dispatchIdentityKey ? { dispatchIdentityKey } : {}),
      };
      try {
        await submitUserIntent({
          sessionId,
          displayContent: input.displayText,
          agentContent: input.agentContent,
          imageDataUrls: input.imageDataUrls,
          source: "dispatch",
          turnIntentId: input.turnIntentId,
          conversationDispatch,
        });
        return true;
      } catch (error) {
        throw new SubmitValidationError(
          error instanceof Error ? error.message : String(error)
        );
      }
    },
    [
      currentSession,
      downloadProgress,
      root,
      selectedTarget,
      sessionId,
      store,
      submitUserIntent,
    ]
  );

  const submit = useCallback(
    async (input: SubmitOverrideInput) => {
      if (await onSurfaceSubmit(input)) return true;
      return enqueueCanonical(input);
    },
    [enqueueCanonical, onSurfaceSubmit]
  );
  const resolveDispatch = useCallback(
    () =>
      buildCanonicalConversationDispatch({
        root,
        selectedTarget,
        auth: store.get(org2CloudAuthAtom),
      }),
    [root, selectedTarget, store]
  );

  return { submit, retry: enqueueCanonical, resolveDispatch };
}
