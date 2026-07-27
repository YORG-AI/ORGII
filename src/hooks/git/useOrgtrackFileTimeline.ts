import { useCallback } from "react";

import {
  type OrgtrackFileTimeline,
  getOrgtrackFileTimeline,
} from "@src/api/tauri/lineage";
import { useAsyncResource } from "@src/hooks/async";

export interface UseOrgtrackFileTimelineOptions {
  repoPath: string;
  filePath: string | null;
  autoLoad?: boolean;
}

export interface UseOrgtrackFileTimelineResult {
  timeline: OrgtrackFileTimeline | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useOrgtrackFileTimeline({
  repoPath,
  filePath,
  autoLoad = true,
}: UseOrgtrackFileTimelineOptions): UseOrgtrackFileTimelineResult {
  const fetchTimeline = useCallback(async (serializedScope: string) => {
    const scope = JSON.parse(serializedScope) as {
      filePath: string;
      repoPath: string;
    };
    return getOrgtrackFileTimeline(scope);
  }, []);
  const scopeKey =
    filePath && repoPath ? JSON.stringify({ filePath, repoPath }) : null;
  const resource = useAsyncResource<OrgtrackFileTimeline | null>({
    autoLoad,
    enabled: Boolean(scopeKey),
    fetcher: fetchTimeline,
    initialData: null,
    scopeKey,
  });

  return {
    timeline: resource.data,
    loading: resource.loading,
    error: resource.error,
    refresh: resource.refresh,
  };
}
