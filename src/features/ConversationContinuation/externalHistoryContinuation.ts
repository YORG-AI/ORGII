import { exists } from "@tauri-apps/plugin-fs";

import {
  externalHistoryCliResumePlan,
  getImportedHistorySourceBySessionId,
} from "@src/api/tauri/externalHistory";
import type { LocalConversationTarget } from "@src/engines/SessionCore/conversations/conversationTypes";
import type { Session } from "@src/store/session";
import { toFsPluginPath } from "@src/util/file/pathUtils";

interface ExternalHistoryContinuationResolution {
  title: string;
  target: LocalConversationTarget;
}

async function pathExistsOnThisDevice(path: string): Promise<boolean> {
  try {
    return await exists(toFsPluginPath(path));
  } catch {
    return false;
  }
}

/**
 * Resolve the checkout for a native continuation on this device.
 *
 * Imported histories can retain an absolute cwd for a deleted worktree or a
 * different machine. Never hand that stale path to the provider process. The
 * user's current workspace is the automatic fallback; this keeps continuation
 * send-only and avoids introducing a workspace picker.
 */
export async function resolveExternalHistoryWorkspace(params: {
  selectedPath?: string | null;
  sourcePath?: string | null;
  fallbackPath?: string | null;
  pathExists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const pathExists = params.pathExists ?? pathExistsOnThisDevice;
  const candidates = [
    params.selectedPath,
    params.sourcePath,
    params.fallbackPath,
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const path = candidate?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (await pathExists(path)) return path;
  }
  return null;
}

export async function resolveExternalHistoryContinuationSource(
  sourceSessionId: string
): Promise<{ cwd: string | null }> {
  const nativePlan = await externalHistoryCliResumePlan(sourceSessionId);
  return { cwd: nativePlan?.cwd ?? null };
}

/**
 * Thin imported-history adapter.
 *
 * Imported providers contribute only identity, title and a device-valid cwd.
 * Execution discovery, native synchronization, queue lifecycle and episode
 * reuse stay in the generic canonical-conversation path.
 */
export async function resolveExternalHistoryContinuation(params: {
  sourceSessionId: string;
  sourceSession?: Session;
  target: LocalConversationTarget;
  fallbackWorkspaceRepoPath?: string | null;
}): Promise<ExternalHistoryContinuationResolution> {
  const source = getImportedHistorySourceBySessionId(params.sourceSessionId);
  if (!source) {
    throw new Error(
      `No imported-history source is registered for ${params.sourceSessionId}`
    );
  }
  const sourceTitle =
    params.sourceSession?.name || `${source.displayName} history`;
  const sourceContinuation = await resolveExternalHistoryContinuationSource(
    params.sourceSessionId
  );
  const workspaceRepoPath = await resolveExternalHistoryWorkspace({
    selectedPath: params.target.workspaceRepoPath,
    sourcePath: sourceContinuation.cwd,
    fallbackPath: params.fallbackWorkspaceRepoPath,
  });
  return {
    title: `Continue ${sourceTitle}`,
    target: {
      ...params.target,
      workspaceRepoPath,
    },
  };
}
