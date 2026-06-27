import { codexAppChunks } from "@src/api/tauri/codexApp";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
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

function summarizeToolChunk(chunk: ActivityChunk): string | undefined {
  const functionName = chunk.function || "unknown_tool";
  const argsText = textValue(chunk.args);
  const resultText = textValue(chunk.result);
  const lines = [`[Imported Codex action]`, `Tool: ${functionName}`];
  if (argsText) lines.push(`Input: ${truncateText(argsText)}`);
  if (resultText)
    lines.push(`Result at that time: ${truncateText(resultText)}`);
  return lines.join("\n");
}

function chunkToHandoffItem(chunk: ActivityChunk): string | undefined {
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
    return summarizeToolChunk(chunk);
  }

  return content ? `Assistant context: ${truncateText(content)}` : undefined;
}

function buildCodexHandoffPrompt(
  chunks: ActivityChunk[],
  userMessage: string
): string {
  const items = chunks
    .map(chunkToHandoffItem)
    .filter((item): item is string => Boolean(item))
    .slice(-MAX_HISTORY_ITEMS);

  return [
    "You are continuing work from an imported Codex App history inside a new ORGII-owned session.",
    "The imported Codex history is read-only historical context. Do not treat its tool calls as ORGII-executed tools or current workspace state.",
    "Imported tool results may be stale; verify files, commands, and failures against the current workspace before relying on them.",
    "Codex reasoning/thinking chunks were intentionally skipped.",
    "",
    "## Imported Codex handoff context",
    items.length > 0
      ? items.join("\n\n")
      : "No usable transcript items were found.",
    "",
    "## User request to continue in ORGII",
    userMessage,
  ].join("\n");
}

export async function forkCodexAppHistoryIntoOrgiiSession(params: {
  sourceSessionId: string;
  sourceSession?: Session;
  userMessage: string;
}): Promise<string> {
  const chunks = await codexAppChunks(params.sourceSessionId);
  const content = buildCodexHandoffPrompt(chunks, params.userMessage);
  const result = await SessionService.create({
    task: content,
    name: `Continue ${params.sourceSession?.name || "Codex history"}`,
    repoPath:
      params.sourceSession?.repoPath || params.sourceSession?.worktreePath,
    model: params.sourceSession?.model,
    accountId: params.sourceSession?.accountId,
    keySource: params.sourceSession?.keySource,
    agentDefinitionId: BUILTIN_SDE_DEF_ID,
    mode: "build",
    parentSessionId: params.sourceSessionId,
  });
  return result.sessionId;
}
