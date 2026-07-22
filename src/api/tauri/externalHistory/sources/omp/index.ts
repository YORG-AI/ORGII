import { invoke } from "@tauri-apps/api/core";

export interface OmpRecentPath {
  path: string;
  name?: string | null;
  lastUsedAt: string;
  sessionCount: number;
}

export async function ompRecentPaths(args?: {
  limit?: number;
}): Promise<OmpRecentPath[]> {
  return invoke<OmpRecentPath[]>("omp_recent_paths", {
    limit: args?.limit,
  });
}
