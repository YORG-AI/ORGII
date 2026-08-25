/** Canonical local identity and runtime fingerprint for one cloud conversation. */
import {
  type ConversationExecutionIdentity,
  resolveConversationExecutionIdentity,
} from "@src/engines/SessionCore/conversations";
import type { ForkSessionSetupSelection } from "@src/features/TeamCollaboration/components/ForkSessionSetupDialog";
import { normalizeSourceEndpointUrl } from "@src/features/TeamCollaboration/engine/collabImportIdentity";

import { type ConversationContinuationRecord } from "./conversationExecutionStore";

export function cloudConversationPlaneKey(
  cloudOrgId: string,
  rootSessionId: string
): string {
  return `${cloudOrgId}:${rootSessionId}`;
}

export interface CloudConversationExecutionIdentity extends ConversationExecutionIdentity {
  authIdentity: string;
  cloudEndpoint: string;
  cloudOrgId: string;
  rootSessionId: string;
  assignedAgentDefinitionId?: string;
  /** Shared transport/read identity. Never contains a local account. */
  planeKey: string;
}

function requireIdentityPart(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`conversation ${label} is required`);
  }
  return value;
}

/**
 * Every entry surface must call this resolver instead of rebuilding only a
 * subset of the tuple. That keeps Work Items, imported replay composers, the
 * setup pill, and future checkpoint handoff on the exact same local identity.
 */
export function resolveCloudConversationExecutionIdentity(input: {
  authIdentity: string;
  cloudEndpoint: string;
  cloudOrgId: string;
  rootSessionId: string;
  assignedAgentDefinitionId?: string | null;
}): CloudConversationExecutionIdentity {
  const authIdentity = requireIdentityPart("auth identity", input.authIdentity);
  const cloudEndpoint = normalizeSourceEndpointUrl(
    requireIdentityPart("cloud endpoint", input.cloudEndpoint)
  );
  const cloudOrgId = requireIdentityPart("organization", input.cloudOrgId);
  const rootSessionId = requireIdentityPart(
    "root session",
    input.rootSessionId
  );
  const assignedAgentDefinitionId =
    input.assignedAgentDefinitionId || undefined;
  const execution = resolveConversationExecutionIdentity({
    root: {
      authority: "org2-cloud",
      authorityScope: [cloudEndpoint, cloudOrgId],
      conversationId: rootSessionId,
    },
    executor: {
      authority: "org2-cloud-account",
      authorityScope: [authIdentity, cloudOrgId],
    },
    agentDefinitionId: assignedAgentDefinitionId,
  });
  return {
    ...execution,
    authIdentity,
    cloudEndpoint,
    cloudOrgId,
    rootSessionId,
    ...(assignedAgentDefinitionId ? { assignedAgentDefinitionId } : {}),
    planeKey: cloudConversationPlaneKey(cloudOrgId, rootSessionId),
  };
}

interface ConversationRuntimeIdentity {
  agentDefinitionId: string;
  cliAgentType?: string;
  accountId?: string;
  model?: string;
  workspaceRepoPath?: string | null;
}

/** Stable, non-secret comparison value. It is not a credential or wire id. */
export function conversationRuntimeFingerprint(
  runtime: ConversationRuntimeIdentity
): string {
  return JSON.stringify([
    "conversation-runtime-v1",
    runtime.agentDefinitionId,
    runtime.cliAgentType ?? "native",
    runtime.accountId ?? null,
    runtime.model ?? null,
    runtime.workspaceRepoPath ?? null,
  ]);
}

export function conversationSetupRuntimeFingerprint(
  setup: ForkSessionSetupSelection
): string {
  return conversationRuntimeFingerprint({
    ...setup.execution,
    workspaceRepoPath: setup.workspaceRepoPath,
  });
}

export function continuationRuntimeFingerprint(
  continuation: ConversationContinuationRecord
): string {
  return conversationRuntimeFingerprint(continuation);
}

/** Mirrors the runner's launch precondition for a remembered CLI setup. */
export function isRunnableConversationSetup(
  setup: ForkSessionSetupSelection | null
): setup is ForkSessionSetupSelection {
  return Boolean(
    setup?.execution.agentDefinitionId &&
    (!setup.execution.cliAgentType || setup.execution.accountId)
  );
}

export function conversationSetupChangesRuntime(
  continuation: ConversationContinuationRecord,
  setup: ForkSessionSetupSelection
): boolean {
  return (
    continuationRuntimeFingerprint(continuation) !==
    conversationSetupRuntimeFingerprint(setup)
  );
}
