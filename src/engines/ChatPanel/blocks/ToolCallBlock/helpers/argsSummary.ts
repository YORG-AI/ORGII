/**
 * Args Summary helpers — build one-line tool-call header subtitles from
 * the raw `args` object passed to each tool.
 */
import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import {
  isBrowserTool,
  isSearchTool,
} from "@src/engines/SessionCore/rendering/registry/toolCategories";
import { extractFilePathFromPayloads } from "@src/util/file/filePathPayload";
import { truncate } from "@src/util/string/truncate";
import {
  deriveToolAction,
  formatBrowserCliCommandTarget,
} from "@src/util/ui/rendering/toolAction";

const SCREENSHOT_MARKER_RE = /\[screenshot:([a-f0-9]{8})\]/g;

/** Strip [screenshot:ID] markers from text for display. */
export function stripScreenshotMarkers(text: string): string {
  return text.replace(SCREENSHOT_MARKER_RE, "").trim();
}

/** Extract screenshot IDs from text containing [screenshot:ID] markers. */
export function extractScreenshotIds(text: string): string[] {
  const ids: string[] = [];
  let match;
  const re = new RegExp(SCREENSHOT_MARKER_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/**
 * Rewrite simple grep alternation (`foo|bar`) into a readable comma list.
 * Leaves general regex patterns unchanged.
 */
function humanizeGrepAlternation(query: string): string {
  if (!query.includes("|") || query.includes("\\|")) return query;
  const parts = query
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return query;
  if (parts.every((part) => /^[\w.-]+$/.test(part))) {
    return parts.join(", ");
  }
  return query;
}

/** One-line subtitle for grep / code-search tool headers. */
export function formatSearchQuerySubtitle(query: string): string {
  const normalized = humanizeGrepAlternation(query.trim());
  if (!normalized) return "";
  return `"${truncate(normalized, 40, { ellipsis: "..." })}"`;
}

function formatSearchArgsSummary(
  _action: string,
  args: Record<string, unknown>
): string {
  const pattern =
    (args.pattern as string | undefined) || (args.query as string | undefined);
  if (pattern) {
    return formatSearchQuerySubtitle(pattern);
  }
  const path = args.path as string | undefined;
  if (path) return path;
  return "";
}

function formatBrowserArgsSummary(
  action: string,
  args: Record<string, unknown>
): string {
  const command = args.command as string | undefined;
  if (command) return formatBrowserCliCommandTarget(action, command);

  switch (action) {
    case "navigate": {
      const url = args.targetUrl as string | undefined;
      return url
        ? `navigate ${truncate(url, 50, { ellipsis: "..." })}`
        : "navigate";
    }
    case "act": {
      const request = args.request as Record<string, unknown> | undefined;
      if (!request) return "act";
      const kind = request.kind as string;
      const ref = request.ref as string | undefined;
      const text = request.text as string | undefined;
      const key = request.key as string | undefined;

      if (kind === "click" && ref) return `click ${ref}`;
      if (kind === "type" && text) {
        return `type "${truncate(text, 30, { ellipsis: "..." })}"${ref ? ` into ${ref}` : ""}`;
      }
      if (kind === "press" && key) return `press ${key}`;
      if (kind === "hover" && ref) return `hover ${ref}`;
      if (kind === "fill") return "fill form";
      if (kind === "evaluate") return "evaluate JS";
      if (kind === "wait") return "wait";
      return `${kind}${ref ? ` ${ref}` : ""}`;
    }
    case "snapshot":
      return `snapshot ${(args.snapshotFormat as string) || "ai"}`;
    case "screenshot":
      return "screenshot";
    case "tabs":
      return "list tabs";
    case "console":
      return "console";
    default:
      return action;
  }
}

/**
 * Build a one-line summary for Agent Team inter-agent comms.
 * Goal: the chat panel's tool-call header subtitle should at a glance
 * tell the user "who is talking to whom about what".
 */
function formatAgentSendMessageSummary(args: Record<string, unknown>): string {
  const recipientMemberId =
    typeof args.recipient_member_id === "string"
      ? args.recipient_member_id
      : "";
  const kind = typeof args.kind === "string" ? args.kind : "message";

  const recipient = recipientMemberId || "?";

  let body = "";
  switch (kind) {
    case "plain": {
      const summary =
        typeof args.summary === "string" && args.summary.trim().length > 0
          ? args.summary
          : typeof args.text === "string"
            ? args.text
            : "";
      if (summary) body = `"${truncate(summary, 60, { ellipsis: "..." })}"`;
      break;
    }
    case "shutdown_request": {
      const reason = typeof args.reason === "string" ? args.reason : "";
      if (reason) body = truncate(reason, 60, { ellipsis: "..." });
      break;
    }
    case "shutdown_response": {
      const accepted = args.accepted === true;
      const note = typeof args.note === "string" ? args.note : "";
      const accLabel = accepted ? "accepted" : "rejected";
      body = note
        ? `${accLabel} · ${truncate(note, 50, { ellipsis: "..." })}`
        : accLabel;
      break;
    }
    default: {
      const note = typeof args.note === "string" ? args.note : "";
      if (note) body = truncate(note, 60, { ellipsis: "..." });
      break;
    }
  }

  const head = `→ ${recipient} · ${kind}`;
  return body ? `${head} · ${body}` : head;
}

export function extractSkillName(args: Record<string, unknown>): string {
  const skill = args.skill;
  return typeof skill === "string" ? skill : "";
}

export function extractArgsSummary(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (toolName === TOOL_NAMES.SKILL) {
    return extractSkillName(args);
  }

  if (toolName === TOOL_NAMES.ORG_SEND_MESSAGE) {
    return formatAgentSendMessageSummary(args);
  }

  const explicitAction = deriveToolAction(toolName, args);
  const isBrowser = isBrowserTool(toolName);
  const action =
    explicitAction ||
    (isBrowser && toolName.includes("_")
      ? toolName.substring(toolName.indexOf("_") + 1)
      : undefined);

  if (action) {
    if (isSearchTool(toolName)) return formatSearchArgsSummary(action, args);
    if (toolName === "manage_story_list") return action;
    if (isBrowser) return formatBrowserArgsSummary(action, args);
    if (toolName === "worktree") {
      const branch = args.branch as string | undefined;
      return branch || "";
    }

    const extraArgs = args.args as string | undefined;
    if (extraArgs) return `${action} ${extraArgs}`;

    const secondaryFields = [
      "message",
      "branch",
      "session_id",
      "name",
      "title",
    ];
    for (const field of secondaryFields) {
      const val = args[field];
      if (typeof val === "string" && val.length > 0) {
        return `${action} ${truncate(val, 50, { ellipsis: "..." })}`;
      }
    }
    return action;
  }

  const url = (args.url || args.uri) as string | undefined;
  if (url) return truncate(url, 60, { ellipsis: "..." });

  const path = extractFilePathFromPayloads([args]);
  if (path) return path;

  const command = args.command as string | undefined;
  if (command) return truncate(command, 60, { ellipsis: "..." });

  const content = args.content as string | undefined;
  if (content && (toolName === "send_message" || toolName === "message"))
    return truncate(content, 60, { ellipsis: "..." });

  return "";
}
