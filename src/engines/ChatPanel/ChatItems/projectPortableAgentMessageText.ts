import { stripThinkTags } from "@src/engines/SessionCore/sync/adapters/shared/streamingParsers";

import { normalizeAssistantMessageText } from "./normalizeAssistantMessageText";

const AGENT_MESSAGE_PLACEHOLDER_LINE = /^\s*\[(?:REDACTED|redacted)\]\s*$/i;

/**
 * Mobile/browser projection of desktop assistant message text.
 *
 * Desktop strips think tags at render time and relies on the host writing-block
 * UI for non-chat variants. Portable surfaces must apply the same hygiene here
 * so protocol placeholders such as `[REDACTED]` never leak into Markdown.
 */
export function projectPortableAgentMessageText(text: string): string {
  const normalized = normalizeAssistantMessageText(text);
  const withoutThinkTags = stripThinkTags(normalized);
  const withoutPlaceholders = withoutThinkTags
    .split(/\r?\n/)
    .filter((line) => !AGENT_MESSAGE_PLACEHOLDER_LINE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return withoutPlaceholders;
}
