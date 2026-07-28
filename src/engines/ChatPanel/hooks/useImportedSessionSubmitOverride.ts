import { useSetAtom } from "jotai";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { waitForSessionChannelReady } from "@src/engines/SessionCore/sync/useSessionChannel";
import type { ForkImportedErrorKind } from "@src/features/TeamCollaboration/useForkImportedSession";
import { useForkImportedSession } from "@src/features/TeamCollaboration/useForkImportedSession";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { Session } from "@src/store/session";
import { restoreToInputAtom } from "@src/store/session/cliSessionStatusAtom";
import type { SessionContinuation } from "@src/store/session/sessionTabPlacementAtom";

import type { SubmitOverrideInput } from "./useInputArea/types";
import { useUserIntentSubmit } from "./useWorkspaceChat/useUserIntentSubmit";

const logger = createLogger("ChatView");

const IMPORTED_FORK_ERROR_KEYS: Record<
  Exclude<ForkImportedErrorKind, "cancelled">,
  string
> = {
  retention: "collaboration.forkImported.retentionError",
  gone: "collaboration.forkImported.goneError",
  replay: "collaboration.forkImported.replayError",
  snapshot: "collaboration.forkImported.snapshotError",
  agent: "collaboration.forkImported.agentError",
  backend: "collaboration.forkImported.backendError",
  generic: "collaboration.forkImported.error",
};

interface UseImportedSessionSubmitOverrideOptions {
  sessionId: string;
  currentSession: Session | undefined;
  onFallbackSubmit: (input: SubmitOverrideInput) => Promise<boolean>;
  onSessionContinuation?: (continuation: SessionContinuation) => void;
}

/**
 * Intercepts the first send from an imported teammate session and routes it
 * through the fork flow. Ordinary sessions continue through the supplied
 * Agent-Org/group-chat submit handler unchanged.
 */
export function useImportedSessionSubmitOverride({
  sessionId,
  currentSession,
  onFallbackSubmit,
  onSessionContinuation,
}: UseImportedSessionSubmitOverrideOptions): (
  input: SubmitOverrideInput
) => Promise<boolean> {
  const { t } = useTranslation("navigation");
  const { openSession } = useSessionView();
  const setRestoreToInput = useSetAtom(restoreToInputAtom);
  const { fork: forkImportedSession } = useForkImportedSession(
    currentSession ?? null
  );
  const forkSubmitInFlightRef = useRef(false);
  // useUserIntentSubmit reads this target so the synthetic user event and
  // dispatch both land in the fork, not the still-mounted imported session.
  const forkDispatchSessionIdRef = useRef<string | null>(null);
  const submitIntoForkedSession = useUserIntentSubmit({
    getSessionId: () => forkDispatchSessionIdRef.current,
  });

  const restorePendingDraft = useCallback(
    (pending: SubmitOverrideInput, targetSessionId: string) => {
      setRestoreToInput({
        sessionId: targetSessionId,
        displayContent: pending.displayText,
        imageDataUrls: pending.imageDataUrls,
      });
    },
    [setRestoreToInput]
  );

  return useCallback(
    async (input: SubmitOverrideInput): Promise<boolean> => {
      if (!currentSession?.importedFrom) {
        return onFallbackSubmit(input);
      }
      if (forkSubmitInFlightRef.current) {
        // A picker/fork is already in flight. Keep a second submission as
        // the imported draft rather than replacing the captured first send.
        restorePendingDraft(input, sessionId);
        return true;
      }

      forkSubmitInFlightRef.current = true;
      try {
        const outcome = await forkImportedSession();
        if (!outcome.ok) {
          restorePendingDraft(input, sessionId);
          if (outcome.errorKind !== "cancelled") {
            Message.error(t(IMPORTED_FORK_ERROR_KEYS[outcome.errorKind]));
          }
          return true;
        }

        forkDispatchSessionIdRef.current = outcome.localSessionId;
        if (onSessionContinuation) {
          onSessionContinuation({
            sessionId: outcome.localSessionId,
            sessionName: outcome.name,
            repoPath: outcome.repoPath,
          });
        } else {
          openSession(outcome.localSessionId, outcome.name, outcome.repoPath);
        }
        try {
          // The first turn can finish before the new IPC channel is mounted.
          // Wait for readiness so agent:complete cannot be lost.
          await waitForSessionChannelReady(outcome.localSessionId);
          await submitIntoForkedSession({
            sessionId: outcome.localSessionId,
            displayContent: input.displayText,
            agentContent: input.agentContent,
            imageDataUrls: input.imageDataUrls,
          });
        } catch (error) {
          logger.error("failed to send captured message into fork", error);
          restorePendingDraft(input, outcome.localSessionId);
          Message.error(t("collaboration.forkImported.sendFailed"));
        } finally {
          forkDispatchSessionIdRef.current = null;
        }
      } finally {
        forkSubmitInFlightRef.current = false;
      }
      return true;
    },
    [
      currentSession?.importedFrom,
      forkImportedSession,
      onFallbackSubmit,
      onSessionContinuation,
      openSession,
      restorePendingDraft,
      sessionId,
      submitIntoForkedSession,
      t,
    ]
  );
}
