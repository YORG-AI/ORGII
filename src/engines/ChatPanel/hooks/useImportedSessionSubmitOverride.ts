import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { waitForSessionChannelReady } from "@src/engines/SessionCore/sync/useSessionChannel";
import {
  getRequiredCloudAccessToken,
  loadCloudConversationInitialContext,
  loadCloudConversationPlaneDelta,
  registerCloudConversationRunner,
  settleCloudConversationRunner,
  signalCloudConversationPlane,
} from "@src/features/Org2Cloud/SessionConversation/cloudConversationRuntime";
import {
  type ConversationFamilyMember,
  resolveConversationFamily,
} from "@src/features/Org2Cloud/SessionConversation/continuationEvents";
import {
  cloudConversationExecutorScopeKey,
  cloudConversationSetupMemoryKey,
  loadStoredOwnerPlaneCursor,
} from "@src/features/Org2Cloud/SessionConversation/conversationExecutionStore";
import { publishOwnerTurn } from "@src/features/Org2Cloud/SessionConversation/conversationOwnerPublisher";
import {
  conversationPlaneAtom,
  conversationPlaneKey,
} from "@src/features/Org2Cloud/SessionConversation/conversationPlaneAtom";
import {
  buildResumePrompt,
  renderPlaneDeltaContext,
  runConversationTurn,
} from "@src/features/Org2Cloud/SessionConversation/conversationTurnRunner";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { findImportedSession } from "@src/features/TeamCollaboration/engine/collabImportIdentity";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import type { ForkImportedErrorKind } from "@src/features/TeamCollaboration/useForkImportedSession";
import { useForkImportedSession } from "@src/features/TeamCollaboration/useForkImportedSession";
import { createLogger } from "@src/hooks/logger";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { Session } from "@src/store/session";
import { sessionsAtom } from "@src/store/session";
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
function memberActivity(member: ConversationFamilyMember): number {
  const parsed = Date.parse(member.row.lastActivityAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

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
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);
  const sessions = useAtomValue(sessionsAtom);
  const auth = useAtomValue(org2CloudAuthAtom);

  // TIP-FOLLOW: a conversation continues at its NEWEST family member no
  // matter which member's surface the send comes from. Without this, a send
  // from an older member forks a SIBLING branch — the reply would ignore
  // everything said since, which is never what "keep chatting" means.
  const lineage = currentSession
    ? getSessionForkedFrom(currentSession)
    : undefined;
  const familyOrgId =
    currentSession?.importedFrom?.orgId ?? lineage?.orgId ?? null;
  const anchorBareSessionId =
    currentSession?.importedFrom?.sourceSessionId ?? sessionId;
  const familyTip = useMemo(() => {
    if (!familyOrgId) return null;
    const rows = remoteEntries[familyOrgId]?.rows;
    if (!rows?.length) return null;
    const family = resolveConversationFamily(rows, anchorBareSessionId);
    if (!family) return null;
    const live = family.filter(
      (member) =>
        !member.row.deletedAt &&
        member.row.eventsEpoch !== undefined &&
        (member.row.eventsCount ?? 0) > 0
    );
    if (live.length === 0) return null;
    const tip = live.reduce((best, member) =>
      memberActivity(member) > memberActivity(best) ? member : best
    );
    return tip.bareSessionId === anchorBareSessionId ? null : tip;
  }, [familyOrgId, remoteEntries, anchorBareSessionId]);
  /** The tip session when it lives on THIS device as a writable session. */
  const ownLocalTip = useMemo(() => {
    if (!familyTip) return null;
    return (
      sessions.find(
        (candidate) => candidate.session_id === familyTip.bareSessionId
      ) ?? null
    );
  }, [familyTip, sessions]);
  /** The tip's imported replay copy — fork source when the tip is remote. */
  const tipImportedCopy = useMemo(() => {
    if (!familyTip || ownLocalTip || !familyOrgId) return null;
    const copy = findImportedSession(
      sessions,
      familyOrgId,
      familyTip.bareSessionId,
      auth?.supabaseUrl
    );
    return copy?.importedFrom ? copy : null;
  }, [familyTip, ownLocalTip, familyOrgId, sessions, auth?.supabaseUrl]);

  const { fork: forkImportedSession } = useForkImportedSession(
    tipImportedCopy ?? currentSession ?? null
  );

  // CONVERSATION PLANE (0024): once the backend supports the multi-writer
  // turn plane, implicit sends stop forking entirely — a member's turn runs
  // in an invisible persistent local continuation and publishes to the plane; the
  // owner's sends keep their own session but inject the plane delta as
  // context. The fork/tip paths below remain ONLY as the pre-0024 fallback.
  const planeEntries = useAtomValue(conversationPlaneAtom);
  const conversationRootId = useMemo(() => {
    if (lineage) return lineage.rootSessionId ?? lineage.sourceSessionId;
    if (currentSession?.importedFrom) {
      const rows = familyOrgId ? remoteEntries[familyOrgId]?.rows : undefined;
      const source = currentSession.importedFrom.sourceSessionId;
      const row = rows?.find(
        (candidate) => candidate.sourceSessionId === source
      );
      return row?.forkedFrom?.rootSessionId ?? source;
    }
    return sessionId;
  }, [
    lineage,
    currentSession?.importedFrom,
    familyOrgId,
    remoteEntries,
    sessionId,
  ]);
  const planeInfo = useMemo(() => {
    if (!conversationRootId) return null;
    if (familyOrgId) {
      const entry =
        planeEntries[conversationPlaneKey(familyOrgId, conversationRootId)];
      return entry
        ? { orgId: familyOrgId, rootId: conversationRootId, entry }
        : null;
    }
    // Own sessions carry no lineage org — recover it from whichever plane
    // entry the open conversation surface already fetched.
    const suffix = `:${conversationRootId}`;
    for (const [key, entry] of Object.entries(planeEntries)) {
      if (key.endsWith(suffix)) {
        return {
          orgId: key.slice(0, -suffix.length),
          rootId: conversationRootId,
          entry,
        };
      }
    }
    return null;
  }, [planeEntries, familyOrgId, conversationRootId]);
  const viewerOwnsRoot = useMemo(
    () =>
      sessions.some((candidate) => candidate.session_id === conversationRootId),
    [sessions, conversationRootId]
  );
  const forkSubmitInFlightRef = useRef(false);
  // useUserIntentSubmit reads this target so the synthetic user event and
  // dispatch both land in the fork, not the still-mounted imported session.
  const forkDispatchSessionIdRef = useRef<string | null>(null);
  const submitIntoForkedSession = useUserIntentSubmit({
    getSessionId: () => forkDispatchSessionIdRef.current,
  });

  // A turn can outlive the access token valid at dispatch (a 10-minute
  // member turn did, live — its tail push failed with "JWT expired"), so
  // every plane push resolves a fresh token from the CURRENT auth state.
  const getAccessToken = useCallback(() => getRequiredCloudAccessToken(), []);

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
      const planeReady = planeInfo?.entry.state === "ready";
      // (a) Member send on a plane-capable backend: publish the message to
      // the conversation immediately, run the turn in an invisible local
      // continuation, stream the agent tail back to the plane. No fork.
      if (planeReady && planeInfo && !viewerOwnsRoot) {
        if (forkSubmitInFlightRef.current) {
          restorePendingDraft(input, sessionId);
          return true;
        }
        forkSubmitInFlightRef.current = true;
        try {
          if (!auth) throw new Error("cloud sign-in required");
          const rootLocal =
            sessions.find(
              (candidate) => candidate.session_id === planeInfo.rootId
            ) ??
            findImportedSession(
              sessions,
              planeInfo.orgId,
              planeInfo.rootId,
              auth.supabaseUrl
            );
          // The root row's repo scope keys the setup memory AND resolves the
          // runner's local checkout — without it the dialog reappears and a
          // workspace-requiring agent cannot launch at all.
          const rootRow = familyOrgId
            ? remoteEntries[familyOrgId]?.rows?.find(
                (candidate) => candidate.sourceSessionId === planeInfo.rootId
              )
            : undefined;
          const authIdentity = org2CloudAuthIdentityKey(auth);
          const executorScope = cloudConversationExecutorScopeKey(
            authIdentity,
            planeInfo.orgId
          );
          let publishResolve!: () => void;
          const userPublished = new Promise<void>((resolve) => {
            publishResolve = resolve;
          });
          let liveRunnerSessionId: string | null = null;
          const dropLiveRunner = () => {
            const runnerSessionId = liveRunnerSessionId;
            if (!runnerSessionId) return;
            liveRunnerSessionId = null;
            settleCloudConversationRunner(
              planeInfo.orgId,
              planeInfo.rootId,
              runnerSessionId
            );
          };
          const turnPromise = runConversationTurn({
            getAccessToken,
            orgId: planeInfo.orgId,
            rootSessionId: planeInfo.rootId,
            conversationTitle:
              currentSession?.name ?? rootLocal?.name ?? "Conversation",
            displayText: input.displayText,
            agentContent: input.agentContent,
            imageDataUrls: input.imageDataUrls,
            loadInitialContext: (excludeTurnIntentId) =>
              loadCloudConversationInitialContext({
                orgId: planeInfo.orgId,
                rootSessionId: planeInfo.rootId,
                streamSessionId: sessionId,
                excludeTurnIntentId,
              }),
            loadPlaneDelta: (afterSeq) =>
              loadCloudConversationPlaneDelta(
                planeInfo.orgId,
                planeInfo.rootId,
                afterSeq,
                getAccessToken
              ),
            sourceScopeKey: rootRow?.repoScopeKey,
            sourceModel: currentSession?.model ?? rootRow?.model,
            assignedAgentDefinitionId: rootRow?.agentDefinitionId,
            setupMemoryKey: cloudConversationSetupMemoryKey(
              authIdentity,
              planeInfo.orgId,
              planeInfo.rootId,
              rootRow?.agentDefinitionId
            ),
            executionScopeKey: executorScope,
            onRunnerReady: (runnerSessionId, turnId, turnIntentId) => {
              // Overlay the runner's LIVE events (thinking / tools / worked-for)
              // into the conversation until the plane carries this turn's
              // agent tail — or the turn settles without one.
              liveRunnerSessionId = runnerSessionId;
              registerCloudConversationRunner({
                orgId: planeInfo.orgId,
                rootSessionId: planeInfo.rootId,
                runnerSessionId,
                turnId,
                turnIntentId,
              });
            },
            onUserMessagePublished: publishResolve,
            onPushed: () => signalCloudConversationPlane(planeInfo.orgId),
          });
          // The composer unblocks as soon as the user's words are on the
          // plane; the agent tail continues in the background.
          const settled = turnPromise.then(
            () => dropLiveRunner(),
            (error) => {
              dropLiveRunner();
              logger.error("conversation turn failed", error);
              Message.error(t("collaboration.forkImported.sendFailed"));
            }
          );
          await Promise.race([userPublished, settled]);
          void settled;
          return true;
        } catch (error) {
          logger.error("conversation plane send failed", error);
          restorePendingDraft(input, sessionId);
          Message.error(t("collaboration.forkImported.sendFailed"));
          return true;
        } finally {
          forkSubmitInFlightRef.current = false;
        }
      }
      // (b) Owner send on a plane-capable backend: the owner's own session
      // stays the execution surface, the agent SEES the members' turns (the
      // plane rows of other authors ride the agent copy as a read-only
      // context prefix — the owner's own turns are already its history),
      // and the turn is PUBLISHED to the plane under a turnId exactly like
      // a member turn, so every turn of the conversation has a seq.
      if (planeReady && planeInfo && viewerOwnsRoot) {
        // Group-chat routing owns its own sends.
        if (await onFallbackSubmit(input)) return true;
        if (!auth) return false;
        const executorScope = cloudConversationExecutorScopeKey(
          org2CloudAuthIdentityKey(auth),
          planeInfo.orgId
        );
        const ownerCursor =
          loadStoredOwnerPlaneCursor(executorScope, planeInfo.rootId)
            ?.readThroughPlaneSeq ?? 0;
        let delta;
        try {
          delta = await loadCloudConversationPlaneDelta(
            planeInfo.orgId,
            planeInfo.rootId,
            ownerCursor,
            getAccessToken
          );
        } catch (error) {
          logger.error("owner conversation delta load failed", error);
          restorePendingDraft(input, sessionId);
          Message.error(t("collaboration.forkImported.sendFailed"));
          return true;
        }
        const othersRows = delta.events.filter(
          (row) => row.authorUserId !== auth.userId
        );
        const agentContent =
          othersRows.length > 0
            ? buildResumePrompt(
                renderPlaneDeltaContext(othersRows),
                input.agentContent ?? input.displayText
              )
            : input.agentContent;
        const turnIntentId = mintTurnIntentId();
        try {
          await submitIntoForkedSession({
            sessionId,
            displayContent: input.displayText,
            agentContent,
            imageDataUrls: input.imageDataUrls,
            turnIntentId,
            applyStopSubmitGuards: true,
            dedupeDirectSubmit: true,
            clearUserInitiatedCancelOnQueue: true,
          });
        } catch (error) {
          logger.error("owner conversation send failed", error);
          restorePendingDraft(input, sessionId);
          Message.error(t("collaboration.forkImported.sendFailed"));
          return true;
        }
        void publishOwnerTurn({
          getAccessToken,
          orgId: planeInfo.orgId,
          rootSessionId: planeInfo.rootId,
          sessionId,
          turnIntentId,
          displayText: input.displayText,
          executorScope,
          readThroughPlaneSeq: delta.lastSeq,
          onPushed: () => signalCloudConversationPlane(planeInfo.orgId),
        }).catch((error: unknown) => {
          logger.warn("owner turn publish failed", error);
        });
        return true;
      }
      // The tip already lives here as a writable session (typically the
      // viewer's own earlier continuation): no new fork — the send goes
      // straight into it, and the surface follows. This is what keeps a
      // back-and-forth conversation ONE conversation instead of a fork
      // per round.
      if (ownLocalTip) {
        if (forkSubmitInFlightRef.current) {
          restorePendingDraft(input, sessionId);
          return true;
        }
        forkSubmitInFlightRef.current = true;
        try {
          forkDispatchSessionIdRef.current = ownLocalTip.session_id;
          const continuation = {
            sessionId: ownLocalTip.session_id,
            sessionName: ownLocalTip.name,
            repoPath: ownLocalTip.repoPath,
          };
          if (onSessionContinuation) {
            onSessionContinuation(continuation);
          } else {
            openSession(
              continuation.sessionId,
              continuation.sessionName,
              continuation.repoPath
            );
          }
          try {
            await waitForSessionChannelReady(ownLocalTip.session_id);
            await submitIntoForkedSession({
              sessionId: ownLocalTip.session_id,
              displayContent: input.displayText,
              agentContent: input.agentContent,
              imageDataUrls: input.imageDataUrls,
            });
          } catch (error) {
            logger.error("failed to send into the conversation tip", error);
            restorePendingDraft(input, ownLocalTip.session_id);
            Message.error(t("collaboration.forkImported.sendFailed"));
          } finally {
            forkDispatchSessionIdRef.current = null;
          }
          return true;
        } finally {
          forkSubmitInFlightRef.current = false;
        }
      }
      // Remote tip (or no family): fork before send. `forkImportedSession`
      // is bound to the tip's imported copy when the family has moved past
      // this surface, so the continuation inherits the WHOLE conversation.
      if (!currentSession?.importedFrom && !tipImportedCopy) {
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
      auth,
      currentSession?.importedFrom,
      currentSession?.name,
      currentSession?.model,
      familyOrgId,
      forkImportedSession,
      getAccessToken,
      onFallbackSubmit,
      onSessionContinuation,
      openSession,
      ownLocalTip,
      planeInfo,
      remoteEntries,
      restorePendingDraft,
      sessionId,
      sessions,
      submitIntoForkedSession,
      t,
      tipImportedCopy,
      viewerOwnsRoot,
    ]
  );
}
