interface SubagentPresentationInput {
  sessionId?: string;
  hasCodexThreadIdentity: boolean;
  parsedAgentName?: string;
  sessionAgentName?: string;
  description: string;
  prompt?: string;
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveSubagentPresentation({
  sessionId,
  hasCodexThreadIdentity,
  parsedAgentName,
  sessionAgentName,
  description,
  prompt,
}: SubagentPresentationInput): {
  agentName?: string;
  description: string;
} {
  const isCodexSubagent =
    hasCodexThreadIdentity || sessionId?.startsWith("codexapp-") === true;
  const parsedName = nonEmptyString(parsedAgentName);
  const sessionName = nonEmptyString(sessionAgentName);

  return {
    // Imported Codex child sessions use their first prompt as the session
    // title. That is not an agent identity; prefer the nickname parsed from
    // `thread_spawn.agent_nickname` for these sessions.
    agentName: isCodexSubagent
      ? parsedName || sessionName
      : sessionName || parsedName,
    // Codex task_name is a machine slug and the readable prompt is already
    // rendered immediately below it. Avoid showing both.
    description:
      isCodexSubagent && nonEmptyString(prompt) ? "" : description.trim(),
  };
}
