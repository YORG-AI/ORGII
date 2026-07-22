import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { externalReplayHandoff } from "@src/api/tauri/externalHistory/replay";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";
import type { Session } from "@src/store/session";

export function buildExternalHistoryHandoffPromptFromItems(
  items: string[],
  userMessage: string,
  sourceName: string
): string {
  return [
    `You are continuing work from an imported ${sourceName} history inside a new ORGII-owned session.`,
    `The imported ${sourceName} history is read-only historical context. Do not treat its tool calls as ORGII-executed tools or current workspace state.`,
    "Imported tool results may be stale; verify files, commands, and failures against the selected workspace before relying on them.",
    "Reasoning/thinking chunks were intentionally skipped.",
    "",
    `## Imported ${sourceName} handoff context`,
    items.length > 0
      ? items.join("\n\n")
      : "No usable transcript items were found.",
    "",
    "## User request to continue in ORGII",
    userMessage,
  ].join("\n");
}

export async function forkExternalHistoryIntoOrgiiSession(params: {
  sourceSessionId: string;
  sourceSession?: Session;
  userMessage: string;
  imageDataUrls?: string[];
}): Promise<string> {
  const source = getImportedHistorySourceBySessionId(params.sourceSessionId);
  if (!source) {
    throw new Error(
      `No imported-history source is registered for ${params.sourceSessionId}`
    );
  }
  const sourceRepoPath =
    params.sourceSession?.repoPath || params.sourceSession?.worktreePath;
  const sourceScopeKeys = sourceRepoPath
    ? await resolveShareableScopeKeys(sourceRepoPath)
    : null;
  // Prompt before loading the potentially large source transcript. The user
  // chooses this machine's real checkout and credentials; an imported model
  // label is only a preference hint, never an execution fallback.
  const setup = await requestForkSessionSetup({
    sourceTitle: params.sourceSession?.name || `${source.displayName} history`,
    sourceScopeKey: sourceScopeKeys?.[0],
    sourceModel: params.sourceSession?.model,
  });
  const handoff = await externalReplayHandoff({
    sessionId: params.sourceSessionId,
    sourceName: source.displayName,
  });
  const content = buildExternalHistoryHandoffPromptFromItems(
    handoff.items,
    params.userMessage,
    source.displayName
  );
  // This continuation is a normal top-level ORGII session. `parentSessionId`
  // is reserved for real subagents and would hide the continuation from the
  // primary session list after a reload. The handoff prompt carries the
  // external source context without changing the new session's hierarchy.
  const result = await SessionService.create({
    task: content,
    imageDataUrls: params.imageDataUrls,
    name: `Continue ${params.sourceSession?.name || `${source.displayName} history`}`,
    repoPath: setup.workspaceRepoPath ?? undefined,
    model: setup.execution.model,
    accountId: setup.execution.accountId,
    keySource: "own_key",
    agentDefinitionId: setup.execution.agentDefinitionId,
    mode: "build",
  });
  return result.sessionId;
}
