import { useAtom } from "jotai";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { useUserIntentSubmit } from "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit";
import { waitForSessionChannelReady } from "@src/engines/SessionCore/sync/useSessionChannel";
import { executeAuthenticatedCloudSessionFork } from "@src/features/TeamCollaboration/cloudSessionFork";
import {
  ForkCancelledError,
  getSessionForkedFrom,
} from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { Session } from "@src/store/session/sessionAtom/types";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import {
  type AddressRoundResult,
  runAddressCommentsRound,
} from "./addressCommentsRun";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import type { SessionCommentTarget } from "./sessionCommentTarget";

const log = createLogger("OwnedCloudCommentAgentRun");

export interface OwnedCloudCommentAgentRunOptions {
  selectedHeadIds?: readonly string[];
  instruction?: string;
}

export function canRunOwnedCloudComments({
  session,
  target,
  viewerOwnsSession,
}: {
  session: Session | null | undefined;
  target: SessionCommentTarget | null;
  viewerOwnsSession: boolean;
}): boolean {
  const forkedFrom = session ? getSessionForkedFrom(session) : undefined;
  const isOwnerSource = session?.session_id === target?.sessionId;
  const isVerifiedSourceFork = Boolean(
    forkedFrom &&
    target &&
    forkedFrom.orgId === target.orgId &&
    forkedFrom.sourceSessionId === target.sessionId
  );
  return Boolean(
    session &&
    target &&
    !session.importedFrom &&
    (isOwnerSource || isVerifiedSourceFork) &&
    viewerOwnsSession
  );
}

/**
 * The single owner-only execution path behind both per-comment @agent and
 * the composer's multi-select Address Comments command.
 *
 * Writable ORGII sources run in place. Immutable local Codex/Claude/Cursor
 * histories first fork their already-published cloud replay through the
 * canonical import/fork flow, then run in that verified writable child while
 * reply_session_comment remains bound to the owner's source threads.
 */
export function useOwnedCloudCommentAgentRun({
  session,
  target,
  viewerOwnsSession,
  onFinished,
}: {
  session: Session | null | undefined;
  target: SessionCommentTarget | null;
  viewerOwnsSession: boolean;
  onFinished?: () => void;
}): {
  available: boolean;
  run: (
    options?: OwnedCloudCommentAgentRunOptions
  ) => Promise<AddressRoundResult | null>;
} {
  const { t } = useTranslation("navigation");
  const { openSession } = useSessionView();
  const [cloudAuth, setCloudAuth] = useAtom(org2CloudAuthAtom);
  const dispatchSessionIdRef = useRef<string | null>(null);
  const submitUserIntent = useUserIntentSubmit({
    getSessionId: () =>
      dispatchSessionIdRef.current ?? session?.session_id ?? null,
  });
  const available = canRunOwnedCloudComments({
    session,
    target,
    viewerOwnsSession,
  });

  const dispatchTurn = useCallback(
    async ({
      displayContent,
      agentContent,
      turnIntentId,
    }: {
      displayContent: string;
      agentContent: string;
      turnIntentId: string;
    }) => {
      const executionSessionId =
        dispatchSessionIdRef.current ?? session?.session_id;
      if (!executionSessionId) {
        throw new Error("no local session for @agent turn");
      }
      await submitUserIntent({
        sessionId: executionSessionId,
        displayContent,
        agentContent,
        turnIntentId,
      });
    },
    [session?.session_id, submitUserIntent]
  );

  const run = useCallback(
    async (
      options?: OwnedCloudCommentAgentRunOptions
    ): Promise<AddressRoundResult | null> => {
      if (!available || !target || !session) return null;
      let executionSessionId = session.session_id;
      try {
        if (isImportedHistorySession(session.session_id)) {
          const current = cloudAuth;
          if (!current) throw new Error("ORG2_CLOUD_SIGN_IN_REQUIRED");
          const fresh = await ensureFreshSession(current);
          if (!fresh) throw new Error("ORG2_CLOUD_SESSION_EXPIRED");
          commitRefreshedAuth(setCloudAuth, current, fresh);
          const outcome = await executeAuthenticatedCloudSessionFork(
            fresh.accessToken,
            {
              orgId: target.orgId,
              sourceSessionId: target.sessionId,
            }
          );
          if (outcome.status === "gone") {
            throw new Error("ORG2_CLOUD_SOURCE_GONE");
          }
          if (!outcome.result) {
            throw new Error("ORG2_CLOUD_REPLAY_NOT_AVAILABLE");
          }
          executionSessionId = outcome.result.localSessionId;
          openSession(
            outcome.result.localSessionId,
            outcome.result.name,
            outcome.result.repoPath
          );
          await waitForSessionChannelReady(executionSessionId);
        }

        dispatchSessionIdRef.current = executionSessionId;
        const result = await runAddressCommentsRound({
          orgId: target.orgId,
          cloudSessionId: target.sessionId,
          localSessionId: executionSessionId,
          dispatchTurn,
          ...(options?.selectedHeadIds !== undefined
            ? { selectedHeadIds: options.selectedHeadIds }
            : {}),
          ...(options?.instruction !== undefined
            ? { instruction: options.instruction }
            : {}),
        });
        onFinished?.();
        return result;
      } catch (error) {
        if (error instanceof ForkCancelledError) return null;
        log.warn(
          `personal @agent round failed: ${error instanceof Error ? error.message : String(error)}`
        );
        Message.error(t("cloud.comments.actionError"));
        return null;
      } finally {
        dispatchSessionIdRef.current = null;
      }
    },
    [
      available,
      cloudAuth,
      dispatchTurn,
      onFinished,
      openSession,
      session,
      setCloudAuth,
      t,
      target,
    ]
  );

  return { available, run };
}
