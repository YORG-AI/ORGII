/** Frontend listener for durable Work Item turns targeting a remote root. */
import { listen } from "@tauri-apps/api/event";
import { z } from "zod/v4";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import { getCloudCapabilitiesConfirmed } from "../org2CloudCapabilities";
import { resolveCloudOrgForProjectOrg } from "../org2CloudProjectOrgAlias";
import { org2CloudRemoteSessionsAtom } from "../org2CloudRemoteSessionsAtom";
import {
  getRequiredCloudAccessToken,
  loadCloudConversationInitialContext,
  loadCloudConversationPlaneDelta,
  registerCloudConversationRunner,
  settleCloudConversationRunner,
  signalCloudConversationPlane,
} from "./cloudConversationRuntime";
import { resolveCloudConversationExecutionIdentity } from "./conversationExecutionIdentity";
import {
  type ConversationInitialContext,
  type RunConversationTurnParams,
  type RunConversationTurnResult,
  runConversationTurn,
} from "./conversationTurnRunner";

const log = createLogger("WorkItemConversationTurnBridge");

export const WORK_ITEM_CONVERSATION_TURN_EVENT =
  "orgii-work-run-conversation-turn";

export const WorkItemConversationTurnRequestSchema = z.object({
  runId: z.string().min(1),
  dispatchId: z.string().min(1),
  claimToken: z.string().min(1),
  orgId: z.string().min(1),
  projectSlug: z.string().nullish(),
  workItemId: z.string().min(1),
  workItemTitle: z.string().nullish(),
  assignedAgentId: z.string().nullish(),
  rootSessionId: z.string().min(1),
  preparedRunnerSessionId: z.string().min(1).nullish(),
  content: z.string().min(1),
  displayText: z.string().nullish(),
  discussionCommentIds: z.array(z.string()).default([]),
});

export type WorkItemConversationTurnRequest = z.infer<
  typeof WorkItemConversationTurnRequestSchema
>;

export interface ConversationTurnCapabilityProbe {
  conversationEvents: boolean;
  conversationEventsIdempotency: boolean;
  confirmed: boolean;
}

export type ConversationTurnAcceptance =
  | { accepted: true; cloudOrgId: string }
  | { accepted: false; reason: string };

export function decideConversationTurnAcceptance(input: {
  signedIn: boolean;
  cloudOrgId: string | null;
  capabilities: ConversationTurnCapabilityProbe | null;
}): ConversationTurnAcceptance {
  if (!input.signedIn) {
    return { accepted: false, reason: "cloud sign-in required" };
  }
  if (!input.cloudOrgId) {
    return {
      accepted: false,
      reason: "work item org is not synced to a cloud org",
    };
  }
  if (!input.capabilities?.confirmed) {
    return { accepted: false, reason: "cloud capabilities unavailable" };
  }
  if (!input.capabilities.conversationEvents) {
    return {
      accepted: false,
      reason: "cloud backend lacks conversation events",
    };
  }
  if (!input.capabilities.conversationEventsIdempotency) {
    return {
      accepted: false,
      reason: "cloud backend lacks retry-safe conversation writes",
    };
  }
  return { accepted: true, cloudOrgId: input.cloudOrgId };
}

export interface ConversationRootHint {
  title?: string;
  repoScopeKey?: string;
  model?: string;
}

export interface WorkItemConversationTurnDeps {
  getAuth: () => Org2CloudAuthState | null;
  getAccessToken: () => Promise<string>;
  resolveCloudOrg: (projectOrgId: string) => Promise<string | null>;
  probeCapabilities: (
    accessToken: string
  ) => Promise<ConversationTurnCapabilityProbe>;
  accept: (runId: string, claimToken: string) => Promise<string | null>;
  release: (runId: string, claimToken: string) => Promise<boolean>;
  nack: (runId: string, claimToken: string, reason: string) => Promise<boolean>;
  prepareRunner: (
    runId: string,
    claimToken: string,
    rootSessionId: string,
    runnerSessionId: string
  ) => Promise<void>;
  ackRunner: (
    runId: string,
    claimToken: string,
    rootSessionId: string,
    runnerSessionId: string
  ) => Promise<void>;
  lookupRoot: (
    cloudOrgId: string,
    rootSessionId: string
  ) => ConversationRootHint;
  loadInitialContext: (params: {
    orgId: string;
    rootSessionId: string;
    streamSessionId: string;
    excludeTurnIntentId: string;
  }) => Promise<ConversationInitialContext>;
  loadPlaneDelta: (
    orgId: string,
    rootSessionId: string,
    afterSeq: number
  ) => ReturnType<typeof loadCloudConversationPlaneDelta>;
  runTurn: (
    params: RunConversationTurnParams
  ) => Promise<RunConversationTurnResult>;
  registerRunner: typeof registerCloudConversationRunner;
  settleRunner: typeof settleCloudConversationRunner;
  signalPlane: typeof signalCloudConversationPlane;
}

export type WorkItemConversationTurnOutcome =
  | "declined"
  | "not_claimed"
  | "succeeded"
  | "failed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function releaseClaimBestEffort(
  deps: WorkItemConversationTurnDeps,
  runId: string,
  claimToken: string
): Promise<void> {
  try {
    await deps.release(runId, claimToken);
  } catch (error) {
    log.warn(`failed to release conversation claim for run ${runId}`, error);
  }
}

export async function handleWorkItemConversationTurnRequest(
  request: WorkItemConversationTurnRequest,
  deps: WorkItemConversationTurnDeps
): Promise<WorkItemConversationTurnOutcome> {
  const auth = deps.getAuth();
  let accessToken: string | null = null;
  let cloudOrgId: string | null = null;
  let capabilities: ConversationTurnCapabilityProbe | null = null;
  if (auth) {
    try {
      accessToken = await deps.getAccessToken();
      cloudOrgId = await deps.resolveCloudOrg(request.orgId);
      if (cloudOrgId) {
        capabilities = await deps.probeCapabilities(accessToken);
      }
    } catch (error) {
      log.warn(`acceptance probe failed for run ${request.runId}`, error);
    }
  }
  const decision = decideConversationTurnAcceptance({
    signedIn: Boolean(accessToken),
    cloudOrgId,
    capabilities,
  });
  if (!decision.accepted) {
    // Every app window receives the event. Incapable windows abstain so they
    // cannot beat a capable window to the Rust claim boundary.
    log.info(
      `conversation turn ${request.runId} abstained: ${decision.reason}`
    );
    return "declined";
  }

  const claimToken = await deps.accept(request.runId, request.claimToken);
  if (!claimToken) return "not_claimed";

  const resolvedOrgId = decision.cloudOrgId;
  const rootSessionId = request.rootSessionId;
  const authIdentity = org2CloudAuthIdentityKey(auth as Org2CloudAuthState);
  const executionIdentity = resolveCloudConversationExecutionIdentity({
    authIdentity,
    cloudOrgId: resolvedOrgId,
    rootSessionId,
    assignedAgentDefinitionId: request.assignedAgentId,
  });
  let runnerSessionId: string | null = null;
  let transportAccepted = false;
  let acknowledged = false;
  let failure: unknown = null;

  try {
    const root = deps.lookupRoot(resolvedOrgId, rootSessionId);
    const result = await deps.runTurn({
      getAccessToken: deps.getAccessToken,
      orgId: resolvedOrgId,
      rootSessionId,
      conversationTitle:
        root.title ?? request.workItemTitle ?? request.workItemId,
      displayText: request.displayText ?? request.content,
      agentContent: request.content,
      loadInitialContext: (excludeTurnIntentId) =>
        deps.loadInitialContext({
          orgId: resolvedOrgId,
          rootSessionId,
          streamSessionId: rootSessionId,
          excludeTurnIntentId,
        }),
      loadPlaneDelta: (afterSeq) =>
        deps.loadPlaneDelta(resolvedOrgId, rootSessionId, afterSeq),
      sourceScopeKey: root.repoScopeKey,
      sourceModel: root.model,
      assignedAgentDefinitionId: request.assignedAgentId ?? undefined,
      setupMemoryKey: executionIdentity.setupMemoryKey,
      executionScopeKey: executionIdentity.executorScopeKey,
      turnIntentId: request.runId,
      requiredRunnerSessionId: request.preparedRunnerSessionId ?? undefined,
      preserveRunnerOnTransportFailure: true,
      onRunnerReady: async (createdRunnerId, turnId, turnIntentId) => {
        runnerSessionId = createdRunnerId;
        deps.registerRunner({
          orgId: resolvedOrgId,
          rootSessionId,
          runnerSessionId: createdRunnerId,
          turnId,
          turnIntentId,
        });
        await deps.prepareRunner(
          request.runId,
          claimToken,
          rootSessionId,
          createdRunnerId
        );
      },
      onTransportAccepted: () => {
        transportAccepted = true;
      },
      onTurnAccepted: async (acceptedRunnerId) => {
        try {
          await deps.ackRunner(
            request.runId,
            claimToken,
            rootSessionId,
            acceptedRunnerId
          );
          acknowledged = true;
        } catch (error) {
          // The exact runtime intent is already durable. Keep its wait/tail
          // pipeline alive and release the claim for backend reconciliation.
          log.warn(
            `durable ack failed after runtime acceptance for run ${request.runId}`,
            error
          );
        }
      },
      onPushed: () => deps.signalPlane(resolvedOrgId),
    });
    return result.terminalStatus === "completed" ? "succeeded" : "failed";
  } catch (error) {
    failure = error;
    log.error(`conversation turn failed for run ${request.runId}`, error);
    return "failed";
  } finally {
    if (!acknowledged) {
      if (failure && !transportAccepted) {
        try {
          await deps.nack(request.runId, claimToken, errorMessage(failure));
        } catch (error) {
          log.warn(`durable nack failed for run ${request.runId}`, error);
          await releaseClaimBestEffort(deps, request.runId, claimToken);
        }
      } else {
        await releaseClaimBestEffort(deps, request.runId, claimToken);
      }
    }
    if (runnerSessionId) {
      deps.settleRunner(resolvedOrgId, rootSessionId, runnerSessionId);
    }
  }
}

export function createWorkItemConversationTurnDeps(): WorkItemConversationTurnDeps {
  const store = getInstrumentedStore();
  return {
    getAuth: () => store.get(org2CloudAuthAtom),
    getAccessToken: getRequiredCloudAccessToken,
    resolveCloudOrg: resolveCloudOrgForProjectOrg,
    probeCapabilities: async (accessToken) => {
      const probe = await getCloudCapabilitiesConfirmed(accessToken);
      return {
        conversationEvents: probe.capabilities.conversationEvents,
        conversationEventsIdempotency: Boolean(
          probe.capabilities.conversationEventsIdempotency
        ),
        confirmed: probe.confirmed,
      };
    },
    accept: (runId, claimToken) =>
      rpc.workRuns.conversationTurnAccept({
        runId,
        claimToken,
        accepted: true,
      }),
    release: (runId, claimToken) =>
      rpc.workRuns.conversationTurnRelease({ runId, claimToken }),
    nack: (runId, claimToken, reason) =>
      rpc.workRuns.conversationTurnNack({ runId, claimToken, reason }),
    prepareRunner: async (
      runId,
      claimToken,
      rootSessionId,
      runnerSessionId
    ) => {
      await rpc.workRuns.conversationTurnPrepareRunner({
        runId,
        claimToken,
        rootSessionId,
        runnerSessionId,
      });
    },
    ackRunner: async (runId, claimToken, rootSessionId, runnerSessionId) => {
      await rpc.workRuns.conversationTurnAckRunner({
        runId,
        claimToken,
        rootSessionId,
        runnerSessionId,
      });
    },
    lookupRoot: (cloudOrgId, rootSessionId) => {
      const row = store
        .get(org2CloudRemoteSessionsAtom)
        [
          cloudOrgId
        ]?.rows.find((candidate) => candidate.sourceSessionId === rootSessionId);
      return {
        title: row?.title,
        repoScopeKey: row?.repoScopeKey,
        model: row?.model,
      };
    },
    loadInitialContext: loadCloudConversationInitialContext,
    loadPlaneDelta: loadCloudConversationPlaneDelta,
    runTurn: runConversationTurn,
    registerRunner: registerCloudConversationRunner,
    settleRunner: settleCloudConversationRunner,
    signalPlane: signalCloudConversationPlane,
  };
}

/** Install once at the app root; Rust remains the cross-window claimant. */
export async function installWorkItemConversationTurnBridge(
  deps: WorkItemConversationTurnDeps = createWorkItemConversationTurnDeps()
): Promise<() => void> {
  const inFlight = new Set<string>();
  return listen<unknown>(WORK_ITEM_CONVERSATION_TURN_EVENT, (event) => {
    const parsed = WorkItemConversationTurnRequestSchema.safeParse(
      event.payload
    );
    if (!parsed.success) {
      log.warn("ignoring malformed conversation turn request", parsed.error);
      return;
    }
    const request = parsed.data;
    const offerKey = JSON.stringify([request.runId, request.claimToken]);
    if (inFlight.has(offerKey)) return;
    inFlight.add(offerKey);
    void handleWorkItemConversationTurnRequest(request, deps)
      .then((outcome) =>
        log.info(`conversation turn ${request.runId}: ${outcome}`)
      )
      .catch((error) =>
        log.error(`conversation turn ${request.runId} crashed`, error)
      )
      .finally(() => inFlight.delete(offerKey));
  });
}
