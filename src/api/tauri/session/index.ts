/**
 * Session API
 *
 * TypeScript wrappers for cross-system session list Rust commands (CLI + SDE + OS).
 */
import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory/imported/descriptors";
import { rpc } from "@src/api/tauri/rpc";
import type {
  ExternalHistorySidebarBatchResponse,
  ExternalHistorySidebarDateBucket,
  ExternalHistorySidebarListRequest,
  ExternalHistorySidebarResponse,
  ExternalHistorySidebarSourceRequest,
  NativeSidebarSessionCursor,
  NativeSidebarSessionPageResponse,
  NativeSidebarSessionStream,
  SessionAggregateRecord,
  SessionFilter,
  SessionListResponse,
} from "@src/api/tauri/rpc/schemas/sessionAggregate";
import { normalizeAgentExecMode } from "@src/config/sessionCreatorConfig";
import type { Session } from "@src/store/session/sessionAtom/types";

import type { DispatchCategory } from "./dispatchTypes";

// Re-export from zero-dep module so callers keep the same import path.
export type { DispatchCategory, KeySource } from "./dispatchTypes";
export {
  DISPATCH_CATEGORY,
  KEY_SOURCE,
  isHostedKey,
  isOwnKey,
} from "./dispatchTypes";
export {
  getSessionLlmUsageSpans,
  getSessionToolUsageAttributions,
  getSessionToolUsageAttributionsForCall,
  TOOL_USAGE_ATTRIBUTION_METHOD,
} from "./usage";
export type {
  LlmUsageSpanRecord,
  ToolUsageAttributionMethod,
  ToolUsageAttributionRecord,
} from "./usage";

// Re-export session aggregate types from RPC schemas (single source of truth).
export type {
  ExternalHistorySidebarBatchResponse,
  ExternalHistorySidebarDateBucket,
  ExternalHistorySidebarListRequest,
  ExternalHistorySidebarResponse,
  ExternalHistorySidebarSourceRequest,
  NativeSidebarSessionCursor,
  NativeSidebarSessionPageResponse,
  NativeSidebarSessionStream,
  SessionAggregateRecord,
  SessionFilter,
  SessionListResponse,
};

// ============================================================================
// API Functions
// ============================================================================

/**
 * Get all sessions with statistics.
 *
 * This replaces the frontend's parallel loading from multiple Tauri commands
 * with a single unified session_aggregate_list call.
 */
export async function sessionAggregateList(
  filter?: SessionFilter
): Promise<SessionListResponse> {
  return rpc.sessionAggregate.list({ filter }) as Promise<SessionListResponse>;
}

export async function nativeSidebarSessionPage(
  stream: NativeSidebarSessionStream,
  cursor: NativeSidebarSessionCursor | null,
  limit: number
): Promise<NativeSidebarSessionPageResponse> {
  return rpc.sessionAggregate.nativeSidebarPage({ stream, cursor, limit });
}

export async function externalHistorySidebarList(
  request: ExternalHistorySidebarListRequest
): Promise<ExternalHistorySidebarBatchResponse> {
  return rpc.sessionAggregate.externalHistorySidebarList(request);
}

// ============================================================================
// Helper Functions
// ============================================================================

function importedHistoryDescriptorForSession(sessionId: string) {
  return IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find((source) =>
    sessionId.startsWith(source.prefix)
  );
}

function getFrontendDispatchCategory(
  record: SessionAggregateRecord
): DispatchCategory {
  const importedSource = importedHistoryDescriptorForSession(record.sessionId);
  if (importedSource) {
    return importedSource.sourceId === "cursor_ide"
      ? "cursor_ide"
      : "external_history";
  }

  // Zod describes the post-transform category type, but production RPC calls
  // intentionally skip output parsing. Normalize the Rust wire value here so
  // native rows do not disappear from frontend category filters in builds.
  const category = record.category as
    | DispatchCategory
    | "cli"
    | "agent"
    | "os"
    | "human";
  if (category === "cli") return "cli_agent";
  if (category === "human") return "human_session";
  if (category === "agent" || category === "os") return "rust_agent";
  return category;
}

export function toFrontendSession(record: SessionAggregateRecord): Session {
  const category = getFrontendDispatchCategory(record);
  const importedSource = importedHistoryDescriptorForSession(record.sessionId);

  return {
    session_id: record.sessionId,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    created_time: record.createdAt,
    updated_time: record.updatedAt,
    user_input: record.userInput,
    repo_name: record.repoName || "",
    name: record.name,
    displayLabel: record.displayLabel,
    branch: record.branch || "",
    is_active: record.isActive,
    category,
    // Imported app history can carry a backend CLI compatibility value, but
    // exposing it here makes app sessions indistinguishable from sessions
    // actually launched through that CLI.
    cliAgentType: importedSource ? undefined : record.cliAgentType,
    model: record.model,
    keySource: record.keySource,
    accountId: record.accountId,
    tier: record.tier,
    pid: record.pid ?? null,
    repoPath: record.repoPath,
    repoRootPath: record.repoRootPath,
    repoRemoteUrls: record.repoRemoteUrls,
    storagePath: record.storagePath,
    worktreePath: record.worktreePath,
    worktreeBranch: record.worktreeBranch,
    baseBranch: record.baseBranch,
    mergeStatus: record.mergeStatus,
    background: record.background,
    orgId: record.orgId,
    projectId: record.projectId,
    projectName: record.projectName,
    projectSlug: record.projectSlug,
    workItemId: record.workItemId,
    agentRole: record.agentRole,
    parentSessionId: record.parentSessionId,
    orgMemberId: record.orgMemberId,
    agentOrgId: record.agentOrgId,
    agentOrgName: record.agentOrgName,
    agentDefinitionId: record.agentDefinitionId,
    agentIconId: importedSource?.iconId ?? record.agentIconId,
    agentDisplayName: importedSource?.displayName ?? record.agentDisplayName,
    agentExecMode: normalizeAgentExecMode(record.agentExecMode) ?? undefined,
    productMode: record.productMode,
    draftText: record.draftText,
    replyTargetEventId: record.replyTargetEventId,
    pinned: record.pinned,
    filesChanged: record.filesChanged,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    touchedFiles: record.touchedFiles,
    totalTokens: record.totalTokens,
  };
}

/**
 * Convert SessionAggregateRecord rows to frontend Session format.
 */
export function toFrontendSessions(
  records: SessionAggregateRecord[]
): Session[] {
  return records.map(toFrontendSession);
}
