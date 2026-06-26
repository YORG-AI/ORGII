/**
 * Rich card parsers — derive structured card data from tool args + results
 * for file, website, work-item, and project tool calls.
 */
import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

import type {
  AgentMessageCardData,
  AgentMessageDeliveryRow,
  CommandArtifact,
  CommandResultData,
  FileCardData,
  ProjectCardData,
  WebsiteCardData,
  WorkItemCardData,
  WorkItemPriority,
  WorkItemStatus,
} from "../types";

function getFileExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return "";
  return base.substring(dotIdx + 1).toLowerCase();
}

export function parseFileCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): FileCardData | null {
  const rawPath =
    (typeof args.path === "string" ? args.path : null) ??
    (typeof args.file_path === "string" ? args.file_path : null) ??
    (typeof result.path === "string" ? result.path : null);
  if (!rawPath) return null;

  const name = rawPath.split("/").pop() ?? rawPath;
  const ext = getFileExt(rawPath);

  const rawSize = result.size_bytes ?? result.sizeBytes ?? args.size_bytes;
  const sizeBytes =
    typeof rawSize === "number" && rawSize >= 0 ? rawSize : undefined;

  return { path: rawPath, name, ext, sizeBytes };
}

export function parseWebsiteCardResult(
  _toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): WebsiteCardData | null {
  const rawUrl =
    (typeof args.url === "string" ? args.url : null) ??
    (typeof args.targetUrl === "string" ? args.targetUrl : null) ??
    (typeof result.url === "string" ? result.url : null);

  if (!rawUrl) return null;
  const normalizedUrl = normalizeHttpUrlCandidate(rawUrl);
  if (!normalizedUrl) return null;

  const content =
    (typeof result.content === "string" ? result.content : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.observation === "string" ? result.observation : null);

  let title: string | undefined;
  let description: string | undefined;

  if (content) {
    const titleMatch =
      content.match(/<title[^>]*>([^<]+)<\/title>/i) ??
      content.match(/^#\s+(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim().substring(0, 100);

    const descMatch = content.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i
    );
    if (descMatch) description = descMatch[1].trim().substring(0, 200);
  }

  if (!title && typeof result.title === "string") title = result.title;

  const screenshotId =
    typeof result.screenshot_id === "string" ? result.screenshot_id : undefined;

  const favicon = `${new URL(normalizedUrl).origin}/favicon.ico`;

  return { url: normalizedUrl, title, description, screenshotId, favicon };
}

const WORK_ITEM_STATUS_MAP: Record<string, WorkItemStatus> = {
  todo: "todo",
  "to do": "todo",
  "to-do": "todo",
  backlog: "backlog",
  "in progress": "in_progress",
  in_progress: "in_progress",
  "in review": "in_review",
  in_review: "in_review",
  done: "done",
  completed: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const WORK_ITEM_PRIORITY_MAP: Record<string, WorkItemPriority> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
  none: "none",
  no_priority: "none",
};

function normalizeWorkItemStatus(raw: string): WorkItemStatus | string {
  return WORK_ITEM_STATUS_MAP[raw.toLowerCase()] ?? raw;
}

function normalizeWorkItemPriority(
  raw: string
): WorkItemPriority | string | undefined {
  return WORK_ITEM_PRIORITY_MAP[raw.toLowerCase()] ?? raw;
}

export function parseWorkItemCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): WorkItemCardData | null {
  const action = typeof args.action === "string" ? args.action : "";
  const singleActions = [
    "create",
    "create_item",
    "update",
    "update_item",
    "get",
    "get_item",
  ];
  if (!singleActions.includes(action)) return null;

  const title =
    (typeof result.title === "string" ? result.title : null) ??
    (typeof args.title === "string" ? args.title : null);
  if (!title) return null;

  const rawId =
    (typeof result.id === "string" ? result.id : null) ??
    (typeof result.short_id === "string" ? result.short_id : null) ??
    "";
  const rawStatus =
    (typeof result.status === "string" ? result.status : null) ??
    (typeof args.status === "string" ? args.status : null) ??
    "todo";
  const rawPriority =
    (typeof result.priority === "string" ? result.priority : null) ??
    (typeof args.priority === "string" ? args.priority : null);
  const projectName =
    (typeof result.project_name === "string" ? result.project_name : null) ??
    (typeof result.project === "string" ? result.project : null) ??
    undefined;
  const assignee =
    (typeof result.assignee === "string" ? result.assignee : null) ?? undefined;
  const dueDate =
    (typeof result.due_date === "string" ? result.due_date : null) ?? undefined;
  const shortId =
    (typeof result.short_id === "string" ? result.short_id : null) ?? undefined;

  return {
    id: rawId,
    title,
    status: normalizeWorkItemStatus(rawStatus),
    priority: rawPriority ? normalizeWorkItemPriority(rawPriority) : undefined,
    projectName,
    assignee,
    dueDate,
    shortId,
  };
}

export function parseProjectCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): ProjectCardData | null {
  const action = typeof args.action === "string" ? args.action : "";
  const singleActions = ["create", "create_item", "update", "update_item"];
  if (!singleActions.includes(action)) return null;

  const name =
    (typeof result.name === "string" ? result.name : null) ??
    (typeof result.title === "string" ? result.title : null) ??
    (typeof args.name === "string" ? args.name : null) ??
    (typeof args.title === "string" ? args.title : null);
  if (!name) return null;

  const rawId =
    (typeof result.id === "string" ? result.id : null) ??
    (typeof result.slug === "string" ? result.slug : null) ??
    "";
  const rawStatus =
    (typeof result.status === "string" ? result.status : null) ??
    (typeof args.status === "string" ? args.status : null) ??
    "backlog";
  const slug =
    (typeof result.slug === "string" ? result.slug : null) ?? undefined;
  const targetDate =
    (typeof result.target_date === "string" ? result.target_date : null) ??
    undefined;
  const workItemCount =
    typeof result.work_item_count === "number"
      ? result.work_item_count
      : undefined;
  const health =
    (typeof result.health === "string" ? result.health : null) ?? undefined;

  return {
    id: rawId,
    name,
    slug,
    status: normalizeWorkItemStatus(rawStatus),
    targetDate,
    workItemCount,
    health,
  };
}

const BUILD_SUCCESS_RE =
  /(?:build|compiled|bundled|built)\s+(?:succeeded?|successfully|completed?)/i;
const BUILD_ARTIFACTS_RE =
  /^\s*(dist\/\S+|\S+\.(js|ts|css|wasm|json|html))\s+([\d.,]+\s*[kmg]?b)/gim;
const NPM_INSTALL_RE = /added\s+(\d+)\s+packages?/i;
const CARGO_BUILD_RE = /Finished\s+\S+\s+\[.*?\]\s+target/i;
const GIT_RE = /^(commit [0-9a-f]{7,}|Merge|Fast-forward|Already up to date)/im;

export function parseCommandResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): CommandResultData | null {
  const command =
    (typeof args.command === "string" ? args.command : null) ??
    (typeof args.cmd === "string" ? args.cmd : null);
  if (!command) return null;

  const rawExitCode = result.exit_code ?? result.exitCode ?? result.code;
  const exitCode =
    typeof rawExitCode === "number"
      ? rawExitCode
      : result.success === true
        ? 0
        : -1;

  const stdout =
    (typeof result.stdout === "string" ? result.stdout : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.content === "string" ? result.content : null) ??
    "";

  if (!stdout && exitCode < 0) return null;

  let summary = "";
  const artifacts: CommandArtifact[] = [];

  if (BUILD_SUCCESS_RE.test(stdout)) {
    summary = "Build succeeded";
    let match;
    const re = new RegExp(BUILD_ARTIFACTS_RE.source, "gim");
    while ((match = re.exec(stdout)) !== null) {
      artifacts.push({ label: match[1].trim(), value: match[3].trim() });
      if (artifacts.length >= 6) break;
    }
  } else if (NPM_INSTALL_RE.test(stdout)) {
    const pkgMatch = stdout.match(NPM_INSTALL_RE);
    summary = pkgMatch ? `Installed ${pkgMatch[1]} packages` : "npm install";
  } else if (CARGO_BUILD_RE.test(stdout)) {
    summary = exitCode === 0 ? "Cargo build succeeded" : "Cargo build failed";
  } else if (GIT_RE.test(stdout)) {
    const firstLine = stdout.trim().split("\n")[0];
    summary = firstLine.substring(0, 80);
  } else {
    return null;
  }

  return { command, exitCode, summary, artifacts };
}

function parseObjectFromContent(
  result: Record<string, unknown>
): Record<string, unknown> | null {
  const content =
    (typeof result.content === "string" ? result.content : null) ??
    (typeof result.output === "string" ? result.output : null) ??
    (typeof result.observation === "string" ? result.observation : null);
  if (!content) return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseDeliveries(value: unknown): AgentMessageDeliveryRow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = asRecord(item);
    const recipientMemberId = getString(row?.recipient_member_id);
    if (!recipientMemberId) return [];
    const inboxId =
      typeof row?.inbox_id === "number" ? row.inbox_id : undefined;
    return [{ recipientMemberId, inboxId }];
  });
}

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}…` : text;
}

export function parseAgentMessageCard(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): AgentMessageCardData {
  const resultObject = parseObjectFromContent(result) ?? result;
  const deliveries = parseDeliveries(resultObject.delivered);
  const recipientMemberId =
    getString(args.recipient_member_id) ??
    deliveries[0]?.recipientMemberId ??
    "";
  const deliveredCount = deliveries.length > 0 ? deliveries.length : undefined;
  const isBroadcast = (deliveredCount ?? 0) > 1;
  const kind = getString(args.kind) ?? getString(resultObject.kind) ?? "plain";
  const requestId =
    getString(args.request_id) ?? getString(resultObject.request_id);
  const senderMemberId =
    getString(resultObject.sender_member_id) ??
    getString(args.sender_member_id) ??
    undefined;
  const sender = senderMemberId ?? "current member";

  let recipient = "?";
  if (isBroadcast) recipient = "broadcast";
  else if (recipientMemberId) recipient = recipientMemberId;

  let summary = "";
  let fullText = "";
  switch (kind) {
    case "plain": {
      const rawText = getString(args.text)?.trim() ?? "";
      const rawSummary = getString(args.summary)?.trim() ?? "";
      fullText = rawText || rawSummary;
      summary = truncateText((rawSummary || rawText).trim(), 120);
      break;
    }
    case "shutdown_request": {
      const reason = getString(args.reason)?.trim() ?? "";
      fullText = reason;
      summary = reason ? truncateText(reason, 80) : "Shutdown requested";
      break;
    }
    case "shutdown_response": {
      const accepted = args.accepted === true;
      const note = getString(args.note)?.trim() ?? "";
      fullText = note;
      summary = note
        ? `${accepted ? "Accepted" : "Rejected"} · ${truncateText(note, 60)}`
        : accepted
          ? "Accepted shutdown"
          : "Rejected shutdown";
      break;
    }
    case "plan_approval_response": {
      const accepted = args.accepted === true;
      const feedback = getString(args.feedback)?.trim() ?? "";
      fullText = feedback;
      summary = feedback
        ? `${accepted ? "Approved plan" : "Requested revision"} · ${truncateText(feedback, 70)}`
        : accepted
          ? "Approved plan"
          : "Requested plan revision";
      break;
    }
    default: {
      const note =
        getString(args.note)?.trim() ?? getString(args.feedback)?.trim() ?? "";
      fullText = note;
      summary = note ? truncateText(note, 80) : kind;
      break;
    }
  }

  const wakeMode =
    typeof resultObject.live_channel === "boolean"
      ? resultObject.live_channel
        ? "live channel"
        : "inbox wake"
      : undefined;

  return {
    sender,
    recipient,
    recipientMemberId: recipientMemberId || undefined,
    senderMemberId,
    isBroadcast,
    kind,
    requestId,
    summary,
    fullText,
    accepted:
      kind === "shutdown_response" || kind === "plan_approval_response"
        ? getBoolean(args.accepted)
        : undefined,
    deliveredCount,
    wakeMode,
    deliveries,
  };
}
