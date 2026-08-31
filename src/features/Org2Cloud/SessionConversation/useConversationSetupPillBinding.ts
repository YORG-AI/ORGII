/**
 * Composer model-pill binding for team-conversation surfaces.
 *
 * Imported replay copies deliberately carry `model: undefined` (the
 * composer used to be a fork entry), so the stock pill reads "Select
 * model" forever, and a manual pick patches the imported row — which the
 * next family refresh wipes. On the conversation plane the model that
 * actually executes a member's turn is the remembered runner setup
 * (`forkSetupMemory`, the same record `runConversationTurn` launches
 * with), so the pill mirrors THAT: display the remembered model, and
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

import type { CloudOrgRemoteSessionsEntry } from "../org2CloudRemoteSessionsAtom";
import { org2CloudRemoteSessionsAtom } from "../org2CloudRemoteSessionsAtom";

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

export function useConversationSetupPillBinding(
  sessionId: string | null | undefined
): ConversationSetupPillBinding | null {
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const importedFrom = session?.importedFrom;
  const remoteEntries = useAtomValue(
    importedFrom ? org2CloudRemoteSessionsAtom : detachedRemoteSessionsAtom
  );
  const memoryVersion = useSyncExternalStore(
    subscribeForkSetupMemory,
    forkSetupMemoryVersion,
    forkSetupMemoryVersion
  );

  // Same derivation the plane submit path uses for its setup lookup: the
  // conversation ROOT row's repo scope keys the memory record.
  const scopeKey = useMemo(() => {
    if (!importedFrom) return undefined;
    const rows = remoteEntries[importedFrom.orgId]?.rows;
    const row = rows?.find(
      (candidate) => candidate.sourceSessionId === importedFrom.sourceSessionId
    );
    const rootId =
      row?.forkedFrom?.rootSessionId ?? importedFrom.sourceSessionId;
    const rootRow = rows?.find(
      (candidate) => candidate.sourceSessionId === rootId
    );
    return rootRow?.repoScopeKey;
  }, [importedFrom, remoteEntries]);

  const selection = useMemo((): LastModelSelection | null => {
    if (!importedFrom) return null;
    void memoryVersion;
    const remembered = loadForkSetupMemory(scopeKey);
    if (!remembered) return null;
    return {
      keySource: KEY_SOURCE.OWN,
      model: remembered.execution.model,
      selectedAccountId: remembered.execution.accountId,
    };
  }, [importedFrom, scopeKey, memoryVersion]);

  const applyModelPick = useCallback(
    (config: AdvancedConfig): boolean => {
      if (isHostedKey(config.keySource) || !config.model) return false;
      const current = loadForkSetupMemory(scopeKey);
      if (!current) return false;
      saveForkSetupMemory(scopeKey, {
        ...current,
        execution: {
          ...current.execution,
          model: config.model,
          accountId: config.selectedAccountId ?? current.execution.accountId,
        },
      });
      return true;
    },
    [scopeKey]
  );

  return useMemo(
    () => (importedFrom ? { selection, applyModelPick } : null),
    [importedFrom, selection, applyModelPick]
  );
}
