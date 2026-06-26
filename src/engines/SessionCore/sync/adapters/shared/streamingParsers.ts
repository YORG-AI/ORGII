/**
 * Shared Agent Event Parsers
 *
 * Streaming JSON argument extraction, shell tool detection, think-tag handling.
 * Used by SDE adapter (and any future agent that streams tool_call_delta).
 *
 * NOTE: Shell tool detection uses isShellTool() from toolCategories.ts
 * (which uses Rust appSubtool mapping as source of truth).
 */
import { isShellTool as isShellToolCategory } from "@src/engines/SessionCore/rendering/registry/toolCategories";

// ── Incremental JSON Argument Parser ──

export interface PartialToolArgs {
  filePath?: string;
  streamContent?: string;
  streamTitle?: string;
  action?: string;
  command?: string;
  query?: string;
  pattern?: string;
  url?: string;
  description?: string;
  targetDirectory?: string;
  targetMode?: string;
  reason?: string;
}

/**
 * Mapping from PartialToolArgs keys to tool argument keys.
 * Used by buildToolArgsFromParsed to convert parsed args to event args.
 */
const PARSED_TO_TOOL_ARG_MAPPING: ReadonlyArray<{
  parsedKey: keyof PartialToolArgs;
  toolKey: string;
}> = [
  { parsedKey: "filePath", toolKey: "file_path" },
  { parsedKey: "streamContent", toolKey: "streamContent" },
  // `create_plan` streams `title` before `content` (schema order). Mapping
  // it to the `title` tool-arg key lets `PlanDocAdapter` show the plan name
  // as soon as the first `"title":"…"` chunk closes, instead of waiting for
  // the full tool_call to finalize. Any other tool that happens to stream
  // a `title` field gets the same free benefit.
  { parsedKey: "streamTitle", toolKey: "title" },
  { parsedKey: "action", toolKey: "action" },
  { parsedKey: "command", toolKey: "command" },
  { parsedKey: "query", toolKey: "query" },
  { parsedKey: "pattern", toolKey: "pattern" },
  { parsedKey: "url", toolKey: "url" },
  { parsedKey: "description", toolKey: "description" },
  { parsedKey: "targetDirectory", toolKey: "target_directory" },
  { parsedKey: "targetMode", toolKey: "target_mode" },
  { parsedKey: "reason", toolKey: "reason" },
];

/**
 * Convert parsed partial args to tool event args object.
 * Only includes non-undefined values.
 */
export function buildToolArgsFromParsed(
  parsed: PartialToolArgs
): Record<string, unknown> {
  const toolArgs: Record<string, unknown> = {};
  for (const { parsedKey, toolKey } of PARSED_TO_TOOL_ARG_MAPPING) {
    const value = parsed[parsedKey];
    if (value !== undefined) {
      toolArgs[toolKey] = value;
    }
  }

  if (parsed.streamContent !== undefined) {
    const action = parsed.action;
    if (action === "apply_patch") {
      toolArgs.patch_text = parsed.streamContent;
    } else if (action !== "edit") {
      toolArgs.content = parsed.streamContent;
    }
  }

  return toolArgs;
}

const CONTENT_KEY_REGEXES: ReadonlyArray<{ key: string; regex: RegExp }> = [
  { key: "new_content", regex: /"new_content"\s*:\s*"/ },
  { key: "newContent", regex: /"newContent"\s*:\s*"/ },
  { key: "new_str", regex: /"new_str"\s*:\s*"/ },
  { key: "new_string", regex: /"new_string"\s*:\s*"/ },
  { key: "newString", regex: /"newString"\s*:\s*"/ },
  { key: "patch_text", regex: /"patch_text"\s*:\s*"/ },
  { key: "patchText", regex: /"patchText"\s*:\s*"/ },
  { key: "content", regex: /"content"\s*:\s*"/ },
];
const FILE_PATH_REGEX =
  /"(?:file_path|filePath|path|target_file|targetFile)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const TITLE_REGEX = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const ACTION_REGEX = /"action"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const COMMAND_REGEX = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const QUERY_REGEX =
  /"(?:query|search_term|search_query)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const PATTERN_REGEX =
  /"(?:pattern|glob_pattern|regex)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const URL_REGEX = /"(?:url|targetUrl)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const DESCRIPTION_REGEX = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const TARGET_DIR_REGEX =
  /"(?:target_directory|directory)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const TARGET_MODE_REGEX = /"target_mode"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const REASON_REGEX = /"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * Extract tool-specific fields from a partial JSON argument string.
 * The JSON is incomplete during streaming, so we use regex for extraction.
 */
export function parsePartialToolArgs(argsJson: string): PartialToolArgs {
  const filePathMatch = argsJson.match(FILE_PATH_REGEX);
  const filePath = filePathMatch?.[1]?.replace(/\\\\/g, "\\");

  const titleMatch = argsJson.match(TITLE_REGEX);
  const streamTitle = titleMatch?.[1]?.replace(/\\\\/g, "\\");

  const actionMatch = argsJson.match(ACTION_REGEX);
  const action = actionMatch?.[1]?.replace(/\\\\/g, "\\");

  const commandMatch = argsJson.match(COMMAND_REGEX);
  const command = commandMatch?.[1]?.replace(/\\\\/g, "\\");

  const queryMatch = argsJson.match(QUERY_REGEX);
  const query = queryMatch?.[1]?.replace(/\\\\/g, "\\");

  const patternMatch = argsJson.match(PATTERN_REGEX);
  const pattern = patternMatch?.[1]?.replace(/\\\\/g, "\\");

  const urlMatch = argsJson.match(URL_REGEX);
  const url = urlMatch?.[1]?.replace(/\\\\/g, "\\");

  const descriptionMatch = argsJson.match(DESCRIPTION_REGEX);
  const description = descriptionMatch?.[1]?.replace(/\\\\/g, "\\");

  const targetDirMatch = argsJson.match(TARGET_DIR_REGEX);
  const targetDirectory = targetDirMatch?.[1]?.replace(/\\\\/g, "\\");

  const targetModeMatch = argsJson.match(TARGET_MODE_REGEX);
  const targetMode = targetModeMatch?.[1];

  const reasonMatch = argsJson.match(REASON_REGEX);
  const reason = reasonMatch?.[1]?.replace(/\\\\/g, "\\");

  let streamContent: string | undefined;

  for (const { regex } of CONTENT_KEY_REGEXES) {
    const keyMatch = argsJson.match(regex);
    if (keyMatch && keyMatch.index !== undefined) {
      const valueStart = keyMatch.index + keyMatch[0].length;
      const rawValue = argsJson.slice(valueStart);
      const cleaned = rawValue.replace(/\\?$/, "").replace(/"?\s*}?\s*$/, "");
      try {
        streamContent = JSON.parse(`"${cleaned}"`);
      } catch {
        streamContent = cleaned
          .replace(/\\n/g, "\n")
          .replace(/\\"/g, '"')
          .replace(/\\t/g, "\t")
          .replace(/\\\\/g, "\\");
      }
      break;
    }
  }

  return {
    filePath,
    streamContent,
    streamTitle,
    action,
    command,
    query,
    pattern,
    url,
    description,
    targetDirectory,
    targetMode,
    reason,
  };
}

// ── Shell tool detection ──

/**
 * Check if a tool is a shell/terminal command tool.
 * Re-exports from toolCategories.ts (uses Rust appSubtool mapping as source of truth).
 */
export function isShellTool(toolName: string): boolean {
  return isShellToolCategory(toolName);
}

// ── Think-tag handling ──

const COMPLETE_THINK_RE = /<think>[\s\S]*?<\/think>/g;
const UNCLOSED_THINK_RE = /<think>[\s\S]*$/;
const COMPLETE_THINK_CAPTURE_RE = /<think>([\s\S]*?)<\/think>/g;

/**
 * Strip `<think>…</think>` blocks that some models embed inline in the
 * content field instead of using the separate reasoning_content channel.
 * Also hides in-progress (unclosed) think blocks during streaming.
 */
export function stripThinkTags(content: string): string {
  let result = content.replace(COMPLETE_THINK_RE, "");
  result = result.replace(UNCLOSED_THINK_RE, "");
  return result;
}

/**
 * Extract the thinking text from inline `<think>` tags.
 * Returns null if no thinking content is found.
 */
export function extractThinkContent(raw: string): string | null {
  const parts: string[] = [];

  let match;
  let lastCompleteEnd = 0;
  const regex = new RegExp(COMPLETE_THINK_CAPTURE_RE.source, "g");
  while ((match = regex.exec(raw)) !== null) {
    const trimmed = match[1].trim();
    if (trimmed) parts.push(trimmed);
    lastCompleteEnd = regex.lastIndex;
  }

  const remaining = raw.slice(lastCompleteEnd);
  const unclosedIdx = remaining.indexOf("<think>");
  if (unclosedIdx !== -1) {
    const unclosed = remaining.slice(unclosedIdx + "<think>".length).trim();
    if (unclosed) parts.push(unclosed);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}
