import { useCallback } from "react";

import {
  getOrgtrackCheckpointFileStates,
  getOrgtrackSessionCheckpoints,
  getOrgtrackSessionDiffChunks,
  getOrgtrackSessionEditArtifacts,
  getOrgtrackSessionFinalDiffs,
} from "@src/api/tauri/lineage";
import type {
  OrgtrackCheckpointFileState,
  OrgtrackSessionCheckpoint,
  OrgtrackSessionDiffChunk,
  OrgtrackSessionEditArtifact,
  OrgtrackSessionFinalDiff,
} from "@src/api/tauri/lineage";
import { useAsyncResource } from "@src/hooks/async";

interface UseOrgtrackSessionArtifactsInput {
  source?: string;
  sessionId?: string;
  enabled?: boolean;
}

interface OrgtrackSessionArtifactsState {
  editArtifacts: OrgtrackSessionEditArtifact[];
  diffChunks: OrgtrackSessionDiffChunk[];
  finalDiffs: OrgtrackSessionFinalDiff[];
  checkpoints: OrgtrackSessionCheckpoint[];
  checkpointFileStatesById: Map<string, OrgtrackCheckpointFileState[]>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

interface OrgtrackSessionArtifactsData {
  editArtifacts: OrgtrackSessionEditArtifact[];
  diffChunks: OrgtrackSessionDiffChunk[];
  finalDiffs: OrgtrackSessionFinalDiff[];
  checkpoints: OrgtrackSessionCheckpoint[];
  checkpointFileStatesById: Map<string, OrgtrackCheckpointFileState[]>;
}

function emptyArtifacts(): OrgtrackSessionArtifactsData {
  return {
    editArtifacts: [],
    diffChunks: [],
    finalDiffs: [],
    checkpoints: [],
    checkpointFileStatesById: new Map(),
  };
}

export function useOrgtrackSessionArtifacts({
  source,
  sessionId,
  enabled = true,
}: UseOrgtrackSessionArtifactsInput): OrgtrackSessionArtifactsState {
  const fetchArtifacts = useCallback(
    async (serializedScope: string): Promise<OrgtrackSessionArtifactsData> => {
      const query = JSON.parse(serializedScope) as {
        source?: string;
        sessionId: string;
      };
      const [editArtifacts, diffChunks, finalDiffs, checkpoints] =
        await Promise.all([
          getOrgtrackSessionEditArtifacts(query),
          getOrgtrackSessionDiffChunks(query),
          getOrgtrackSessionFinalDiffs(query),
          getOrgtrackSessionCheckpoints(query),
        ]);
      const stateEntries = await Promise.all(
        checkpoints.map(
          async (checkpoint) =>
            [
              checkpoint.checkpointId,
              await getOrgtrackCheckpointFileStates(checkpoint.checkpointId),
            ] as const
        )
      );
      return {
        editArtifacts,
        diffChunks,
        finalDiffs,
        checkpoints,
        checkpointFileStatesById: new Map(stateEntries),
      };
    },
    []
  );
  const scopeKey =
    enabled && sessionId ? JSON.stringify({ source, sessionId }) : null;
  const resource = useAsyncResource({
    enabled: Boolean(scopeKey),
    fetcher: fetchArtifacts,
    initialData: emptyArtifacts(),
    scopeKey,
  });

  return {
    ...resource.data,
    loading: resource.loading,
    error: resource.error,
    reload: resource.refresh,
  };
}
