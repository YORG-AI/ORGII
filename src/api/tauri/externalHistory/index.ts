import { invoke } from "@tauri-apps/api/core";

import type { RepoKind } from "@src/api/tauri/repo";

export type {
  ExternalCliCapabilities,
  ExternalCliSourceProbe,
} from "./detection";
export { externalCliSourceProbe, externalCliSourcesDetect } from "./detection";
export { externalHistoryRescanSource } from "./rescan";
export {
  fetchExternalSourceStats,
  type ExternalSourceStats,
} from "./sourceStats";
export * from "./cursorIde";
export * from "./imported";
export * from "./sources/claudeCode";
export * from "./sources/codexApp";
export * from "./sources/opencode";
export * from "./sources/qoder";
export * from "./sources/trae";
export * from "./sources/windsurf";
export * from "./sources/workbuddy";
export * from "./sources/warp";

export interface ExternalHistoryImportedRepo {
  repoId: string;
  name: string;
  path: string;
  kind: RepoKind;
}

interface ExternalHistoryImportedRepoWire {
  repo_id: string;
  name: string;
  path: string;
  kind: RepoKind;
}

export async function externalHistoryAutoImportRecentPaths(options?: {
  limit?: number;
}): Promise<ExternalHistoryImportedRepo[]> {
  const rows = await invoke<ExternalHistoryImportedRepoWire[]>(
    "external_history_auto_import_recent_paths",
    { limit: options?.limit }
  );

  return rows.map((row) => ({
    repoId: row.repo_id,
    name: row.name,
    path: row.path,
    kind: row.kind,
  }));
}
