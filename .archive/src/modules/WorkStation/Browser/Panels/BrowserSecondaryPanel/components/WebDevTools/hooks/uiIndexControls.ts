/**
 * Retired WebDevTools component-index controls.
 *
 * These wrappers preserve the frontend status/build/clear IPC boundary that
 * was formerly embedded in `useWebDevToolsElementsPanel`.
 */
import { invoke } from "@tauri-apps/api/core";

export async function isUiIndexBuilt(repoPath: string): Promise<boolean> {
  return invoke<boolean>("ui_index_is_repo_indexed", { repoPath });
}

export async function buildUiIndex(repoPath: string): Promise<void> {
  await invoke("ui_index_build_repo", { repoPath });
}

export async function clearUiIndex(repoPath: string): Promise<void> {
  await invoke("ui_index_clear", { repoPath });
}
