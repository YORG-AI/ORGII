import type { ReactNode } from "react";

import type { WorkItemData } from "@src/api/http/project";
import type {
  PayloadRef,
  ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";

export interface ToolCallBlockProps {
  /** Tool/function name (e.g. "git", "web_fetch", "session") */
  toolName: string;
  /**
   * Pre-resolved header title. Built-in tool labels come from the Rust registry;
   * unregistered / MCP tools fall back to title-cased names.
   */
  title?: string;
  /** Tool arguments */
  args?: Record<string, unknown>;
  /** Tool result */
  result?: Record<string, unknown>;
  /** Whether currently loading */
  isLoading?: boolean;
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
  /** Optional event ID for simulator replay */
  eventId?: string;
  /** Override the auto-detected tool icon (e.g. MCP logo) */
  iconOverride?: ReactNode;
  /**
   * Per-tool-call identifier. Required alongside `sessionId` to surface
   * `agent:mcp_progress` ticks inline via `McpProgressRow` while the
   * remote MCP server is still streaming. Absent for events that cannot
   * produce progress notifications (legacy rows, synthetic bubbles).
   */
  callId?: string;
  /**
   * Session the tool call belongs to. Paired with `callId` for the MCP
   * progress lookup; without both, `McpProgressRow` is skipped.
   */
  sessionId?: string;
  toolUsage?: ToolUsageMetadata;
  payloadRefs?: PayloadRef[];
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "git" | "folder";
}

/**
 * Key/value row for the `manage_workspace` Info block (add/clone/create/remove).
 *
 * Rendered as a composer-stack row with no leading icon — `label` on the left,
 * `value` right-aligned, matching the `list` action's expandable stack
 * geometry. Both fields are literal English strings (not i18n keys); these
 * developer-facing labels (Operation / Path / URL / …) and operation phrases
 * (Add local repo / Clone from GitHub / …) stay in English across all
 * locales.
 */
export interface WorkspaceInfoRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Row for the `await_output(command=list)` styled output.
 *
 * Reuses the `manage_workspace > list` stack geometry (icon + primary label +
 * secondary path) so agent-initiated background jobs render with the same
 * familiar shape as tracked workspaces. The discriminator `jobKind` picks
 * between Terminal/Bot icons at render time.
 */
export interface BackgroundJobRow {
  handle: string;
  jobKind: "shell" | "subagent";
  status: "running" | "succeeded" | "failed";
  ageLabel: string;
  label: string;
}

export type ProjectToolRowChange = "added" | "updated" | "deleted";

export interface ProjectToolListRow {
  name: string;
  change?: ProjectToolRowChange;
}

export interface LspStatusRow {
  key: string;
  label: string;
  value: string;
}

export interface LspStatusOutputData {
  language?: string;
  running?: boolean;
  rows: LspStatusRow[];
}

// ============================================
// Rich card output types
// ============================================

/**
 * Single file written/read by the agent.
 * Rendered as a compact file chip with icon, name, path, and optional size.
 */
export interface FileCardData {
  path: string;
  name: string;
  ext: string;
  sizeBytes?: number;
}

/**
 * Web page previewed or fetched by the agent.
 * Rendered as a link card with favicon, title, description, and URL.
 */
export interface WebsiteCardData {
  url: string;
  title?: string;
  description?: string;
  screenshotId?: string;
  favicon?: string;
}

/** Priority classification for work items and projects. */
export type WorkItemPriority = "urgent" | "high" | "medium" | "low" | "none";

/** Status classification covering both projects and work items. */
export type WorkItemStatus =
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "cancelled"
  | "backlog";

/**
 * Single work item created/updated/deleted by the agent.
 * Rendered as a status chip card with title, priority badge, and metadata row.
 */
export interface WorkItemCardData {
  id: string;
  title: string;
  status: WorkItemStatus | string;
  priority?: WorkItemPriority | string;
  projectName?: string;
  assignee?: string;
  dueDate?: string;
  shortId?: string;
}

/**
 * Single project created/updated by the agent.
 * Rendered as a project chip card with health indicator, target date, and item count.
 */
export interface ProjectCardData {
  id: string;
  name: string;
  slug?: string;
  status: WorkItemStatus | string;
  targetDate?: string;
  workItemCount?: number;
  health?: string;
}

/** A labelled artifact emitted by a shell command (e.g. a built file + size). */
export interface CommandArtifact {
  label: string;
  value: string;
}

/**
 * Structured result from a shell command with a parseable summary.
 * Rendered as a terminal-style card with command, exit status, summary, and
 * optional artifact rows.
 */
export interface CommandResultData {
  command: string;
  exitCode: number;
  summary: string;
  artifacts?: CommandArtifact[];
}

/**
 * Parsed `org2-pm` CLI envelope surfaced from a shell tool call, so an
 * agent-plane work-system write renders as a work card instead of a raw
 * terminal block (design S3 envelope renderer).
 */
export interface OrgtrackEnvelopeData {
  command: string;
  ok: boolean;
  operationId: string;
  operation: string;
  exitCode: number;
  shortId?: string;
  title?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  itemCount?: number;
  /** Canonical create/update result used to open the real Work Item detail surface. */
  workItem?: WorkItemData;
  /** Resolved navigation context; empty for standalone items. */
  projectSlug?: string;
  projectName?: string;
  projectId?: string;
  orgId?: string;
  isStandalone?: boolean;
}

/**
 * Inter-agent message sent via the Agent Team messaging tool.
 * Rendered as a compact speech-bubble card with recipient, kind, and summary.
 */
export interface AgentMessageDeliveryRow {
  recipientMemberId: string;
  inboxId?: number;
}

export interface AgentMessageCardData {
  sender: string;
  recipient: string;
  recipientMemberId?: string;
  senderMemberId?: string;
  isBroadcast: boolean;
  kind: string;
  requestId?: string;
  summary: string;
  fullText?: string;
  accepted?: boolean;
  deliveredCount?: number;
  wakeMode?: string;
  deliveries: AgentMessageDeliveryRow[];
}

export interface TaskUpdateCardData {
  action: "created" | "updated" | "deleted";
  id: string;
  subject?: string;
  activeForm?: string;
  status?: string;
  owner?: string;
  ownerChanged?: boolean;
  taskAssignedDispatched?: boolean;
  blocks: string[];
  blockedBy: string[];
}

export interface TaskListCardData {
  kind: "get" | "list" | "graph";
  tasks: TaskUpdateCardData[];
  total?: number;
  orgRunId?: string;
}

export type StyledOutput =
  | { type: "workspaces"; workspaces: WorkspaceEntry[] }
  | { type: "workspaceInfo"; rows: WorkspaceInfoRow[] }
  | { type: "jobListing"; jobs: BackgroundJobRow[] }
  | { type: "projectToolList"; rows: ProjectToolListRow[] }
  | { type: "lspStatus"; data: LspStatusOutputData }
  | { type: "files"; files: string[]; repoPath?: string }
  | { type: "noResult"; message: string }
  | { type: "fileCard"; card: FileCardData }
  | { type: "websiteCard"; card: WebsiteCardData }
  | { type: "workItemCard"; card: WorkItemCardData }
  | { type: "projectCard"; card: ProjectCardData }
  | { type: "commandResult"; card: CommandResultData }
  | { type: "orgtrackEnvelope"; card: OrgtrackEnvelopeData }
  | { type: "agentMessageCard"; card: AgentMessageCardData };

export interface OutputContentProps {
  styledOutput: StyledOutput | null;
  isBrowserSnapshot: boolean;
  resultContent: string;
  hasOutput: boolean;
  outputText: string;
  isError: boolean;
  hasResult: boolean;
  completedLabel: string;
  sessionId?: string;
  eventId?: string;
  payloadRef?: PayloadRef;
}
