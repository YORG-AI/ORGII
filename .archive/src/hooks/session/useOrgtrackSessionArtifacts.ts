import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  error: Error | null;
  reload: () => Promise<void>;
}

export function useOrgtrackSessionArtifacts({
  source,
  sessionId,
  enabled = true,
}: UseOrgtrackSessionArtifactsInput): OrgtrackSessionArtifactsState {
  const [editArtifacts, setEditArtifacts] = useState<
    OrgtrackSessionEditArtifact[]
  >([]);
  const [diffChunks, setDiffChunks] = useState<OrgtrackSessionDiffChunk[]>([]);
  const [finalDiffs, setFinalDiffs] = useState<OrgtrackSessionFinalDiff[]>([]);
  const [checkpoints, setCheckpoints] = useState<OrgtrackSessionCheckpoint[]>(
    []
  );
  const [checkpointFileStatesById, setCheckpointFileStatesById] = useState<
    Map<string, OrgtrackCheckpointFileState[]>
  >(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const query = useMemo(() => ({ source, sessionId }), [source, sessionId]);

  const reload = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!enabled || !sessionId) {
      setEditArtifacts([]);
      setDiffChunks([]);
      setFinalDiffs([]);
      setCheckpoints([]);
      setCheckpointFileStatesById(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const [
        nextEditArtifacts,
        nextDiffChunks,
        nextFinalDiffs,
        nextCheckpoints,
      ] = await Promise.all([
        getOrgtrackSessionEditArtifacts(query),
        getOrgtrackSessionDiffChunks(query),
        getOrgtrackSessionFinalDiffs(query),
        getOrgtrackSessionCheckpoints(query),
      ]);
      const stateEntries = await Promise.all(
        nextCheckpoints.map(
          async (checkpoint) =>
            [
              checkpoint.checkpointId,
              await getOrgtrackCheckpointFileStates(checkpoint.checkpointId),
            ] as const
        )
      );
      if (requestIdRef.current !== requestId) {
        return;
      }
      setEditArtifacts(nextEditArtifacts);
      setDiffChunks(nextDiffChunks);
      setFinalDiffs(nextFinalDiffs);
      setCheckpoints(nextCheckpoints);
      setCheckpointFileStatesById(new Map(stateEntries));
    } catch (caughtError) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setError(
        caughtError instanceof Error
          ? caughtError
          : new Error(String(caughtError))
      );
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [enabled, query, sessionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    editArtifacts,
    diffChunks,
    finalDiffs,
    checkpoints,
    checkpointFileStatesById,
    loading,
    error,
    reload,
  };
}
