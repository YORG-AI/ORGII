/**
 * Composer model-pill binding for team-conversation surfaces.
 *
 * Imported replay copies deliberately carry `model: undefined` (the
 * composer used to be a fork entry), so the stock pill reads "Select
 * model" forever, and a manual pick patches the imported row — which the
 * next family refresh wipes. On the conversation plane the model that
 * will execute a member's next turn is the remembered runner setup
 * (`forkSetupMemory`, the same record `runConversationTurn` launches with).
 * A changed setup rolls the active episode under the next serialized turn,
 * so the pill mirrors that desired runtime: display the remembered model, and
 * route picks back into the memory so they stick across sends,
 * refreshes, and restarts.
 */
import { atom, useAtomValue } from "jotai";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import {
  forkSetupMemoryVersion,
  loadForkSetupMemory,
  saveForkSetupMemory,
  subscribeForkSetupMemory,
} from "@src/features/TeamCollaboration/forkSetupMemory";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";

import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "../org2CloudAuthAtom";
import type { CloudOrgRemoteSessionsEntry } from "../org2CloudRemoteSessionsAtom";
import { org2CloudRemoteSessionsAtom } from "../org2CloudRemoteSessionsAtom";
import {
  type CloudConversationExecutionIdentity,
  resolveCloudConversationExecutionIdentity,
} from "./conversationExecutionIdentity";

const detachedRemoteSessionsAtom = atom<
  Record<string, CloudOrgRemoteSessionsEntry>
>({});

export interface ConversationSetupPillBinding {
  /** Remembered runner selection; null until the first setup is confirmed. */
  selection: LastModelSelection | null;
  /**
   * Persist a palette pick into the remembered runner setup. Returns false
   * when there is nothing to update yet (no confirmed setup, or a hosted
   * pick the own-key runner cannot launch) — the first send's setup dialog
   * remains the authoritative fallback.
   */
  applyModelPick: (config: AdvancedConfig) => boolean;
}

interface ImportedConversationIdentity {
  orgId: string;
  sourceSessionId: string;
}

interface ConversationIdentityRow {
  sourceSessionId: string;
  agentDefinitionId?: string;
  forkedFrom?: { rootSessionId?: string } | null;
}

export function resolveConversationSetupPillIdentity(input: {
  authIdentity: string | null;
  importedFrom: ImportedConversationIdentity | null | undefined;
  rows: readonly ConversationIdentityRow[] | null | undefined;
}): CloudConversationExecutionIdentity | null {
  if (!input.importedFrom || !input.authIdentity) return null;
  const source = input.rows?.find(
    (candidate) =>
      candidate.sourceSessionId === input.importedFrom?.sourceSessionId
  );
  const rootSessionId =
    source?.forkedFrom?.rootSessionId ?? input.importedFrom.sourceSessionId;
  const root = input.rows?.find(
    (candidate) => candidate.sourceSessionId === rootSessionId
  );
  return resolveCloudConversationExecutionIdentity({
    authIdentity: input.authIdentity,
    cloudOrgId: input.importedFrom.orgId,
    rootSessionId,
    assignedAgentDefinitionId: root?.agentDefinitionId,
  });
}

export function useConversationSetupPillBinding(
  sessionId: string | null | undefined
): ConversationSetupPillBinding | null {
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const auth = useAtomValue(org2CloudAuthAtom);
  const importedFrom = session?.importedFrom;
  const remoteEntries = useAtomValue(
    importedFrom ? org2CloudRemoteSessionsAtom : detachedRemoteSessionsAtom
  );
  const memoryVersion = useSyncExternalStore(
    subscribeForkSetupMemory,
    forkSetupMemoryVersion,
    forkSetupMemoryVersion
  );

  const authIdentity = auth ? org2CloudAuthIdentityKey(auth) : null;
  // Resolve the exact account/org/root/agent tuple used by both plane submit
  // paths. A repository scope is a workspace hint, never an executor identity.
  const executionIdentity = useMemo(() => {
    return resolveConversationSetupPillIdentity({
      authIdentity,
      importedFrom,
      rows: importedFrom ? remoteEntries[importedFrom.orgId]?.rows : undefined,
    });
  }, [authIdentity, importedFrom, remoteEntries]);

  const selection = useMemo((): LastModelSelection | null => {
    if (!importedFrom) return null;
    void memoryVersion;
    if (!executionIdentity) return null;
    const remembered = loadForkSetupMemory(executionIdentity.setupMemoryKey);
    if (!remembered) return null;
    return {
      keySource: KEY_SOURCE.OWN,
      model: remembered.execution.model,
      selectedAccountId: remembered.execution.accountId,
    };
  }, [executionIdentity, importedFrom, memoryVersion]);

  const applyModelPick = useCallback(
    (config: AdvancedConfig): boolean => {
      if (isHostedKey(config.keySource) || !config.model) return false;
      if (!executionIdentity) return false;
      const current = loadForkSetupMemory(executionIdentity.setupMemoryKey);
      if (!current) return false;
      saveForkSetupMemory(executionIdentity.setupMemoryKey, {
        ...current,
        execution: {
          ...current.execution,
          model: config.model,
          accountId: config.selectedAccountId ?? current.execution.accountId,
        },
      });
      return true;
    },
    [executionIdentity]
  );

  return useMemo(
    () => (importedFrom ? { selection, applyModelPick } : null),
    [importedFrom, selection, applyModelPick]
  );
}
