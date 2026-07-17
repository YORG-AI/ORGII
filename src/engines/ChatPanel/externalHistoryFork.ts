import { getImportedHistorySourceBySessionId } from "@src/api/tauri/externalHistory";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";
import type { Session } from "@src/store/session";
import type { ActivityChunk } from "@src/types/session/session";
import { BUILTIN_SDE_DEF_ID } from "@src/util/session/sessionDispatch";

const MAX_HISTORY_ITEMS = 80;
const MAX_TEXT_LENGTH = 1200;

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(textValue).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      textValue(object.text) ??
      textValue(object.content) ??
      textValue(object.message) ??
      textValue(object.output) ??
      textValue(object.summary)
    );
  }
  return undefined;
}

function truncateText(text: string): string {
  return text.length > MAX_TEXT_LENGTH
    ? `${text.slice(0, MAX_TEXT_LENGTH)}…`
    : text;
}

function summarizeToolChunk(
  chunk: ActivityChunk,
  sourceName: string
): string | undefined {
  const functionName = chunk.function || "unknown_tool";
  const argsText = textValue(chunk.args);
  const resultText = textValue(chunk.result);
  const lines = [`[Imported ${sourceName} action]`, `Tool: ${functionName}`];
  if (argsText) lines.push(`Input: ${truncateText(argsText)}`);
  if (resultText)
    lines.push(`Result at that time: ${truncateText(resultText)}`);
  return lines.join("\n");
}

function chunkToHandoffItem(
  chunk: ActivityChunk,
  sourceName: string
): string | undefined {
  const actionType = chunk.action_type;
  if (actionType.includes("thinking") || actionType.includes("reasoning")) {
    return undefined;
  }

  const resultText = textValue(chunk.result);
  const argsText = textValue(chunk.args);
  const content = resultText ?? argsText;

  if (actionType === "user_message" || chunk.function === "user_message") {
    return content ? `User: ${truncateText(content)}` : undefined;
  }
  if (
    actionType === "assistant_message" ||
    actionType === "llm_response" ||
    chunk.function === "assistant_message"
  ) {
    return content ? `Assistant: ${truncateText(content)}` : undefined;
  }
  if (actionType === "tool_call" || actionType.includes("tool")) {
    return summarizeToolChunk(chunk, sourceName);
  }

  return content ? `Assistant context: ${truncateText(content)}` : undefined;
}

export function buildExternalHistoryHandoffPrompt(
  chunks: ActivityChunk[],
  userMessage: string,
  sourceName: string
): string {
  const items = chunks
    .map((chunk) => chunkToHandoffItem(chunk, sourceName))
    .filter((item): item is string => Boolean(item))
    .slice(-MAX_HISTORY_ITEMS);

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
  const chunks = await source.loadFullTranscriptChunks(params.sourceSessionId);
  const content = buildExternalHistoryHandoffPrompt(
    chunks,
    params.userMessage,
    source.displayName
  );
  const result = await SessionService.create({
    task: content,
    imageDataUrls: params.imageDataUrls,
    name: `Continue ${params.sourceSession?.name || `${source.displayName} history`}`,
    repoPath: setup.workspaceRepoPath ?? undefined,
    model: setup.execution.model,
    accountId: setup.execution.accountId,
    keySource: "own_key",
    agentDefinitionId: BUILTIN_SDE_DEF_ID,
    mode: "build",
    parentSessionId: params.sourceSessionId,
  });
  return result.sessionId;
}
