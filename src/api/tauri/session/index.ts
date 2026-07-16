/**
 * Session API
 *
 * TypeScript wrappers for cross-system session list Rust commands (CLI + SDE + OS).
 */
import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory/imported/descriptors";
import { rpc } from "@src/api/tauri/rpc";
import type {
  AggregateStats,
  SessionAggregateRecord,
  SessionFilter,
  SessionHeatmapFilter,
  SessionHeatmapResponse,
  SessionListResponse,
  SessionUsageSummary,
} from "@src/api/tauri/rpc/schemas/sessionAggregate";
import { normalizeAgentExecMode } from "@src/config/sessionCreatorConfig";
import type { Session } from "@src/store/session/sessionAtom/types";

import type { DispatchCategory, KeySource } from "./dispatchTypes";

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
  AggregateStats,
  SessionAggregateRecord,
  SessionFilter,
  SessionHeatmapFilter,
  SessionHeatmapResponse,
  SessionListResponse,
  SessionUsageSummary,
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

/**
 * Get aggregate statistics for sessions.
 *
 * Optionally filter by session IDs or key source.
 */
export async function sessionGetAggregateStats(
  sessionIds?: string[],
  keySource?: KeySource
): Promise<AggregateStats> {
  return rpc.sessionAggregate.getStats({
    sessionIds,
    keySource,
  }) as Promise<AggregateStats>;
}

export async function sessionUsageSummary(
  sessionId: string
): Promise<SessionUsageSummary> {
  return rpc.sessionAggregate.usageSummary({
    sessionId,
  }) as Promise<SessionUsageSummary>;
}

export async function sessionHeatmap(
  filter?: SessionHeatmapFilter
): Promise<SessionHeatmapResponse> {
  return rpc.sessionAggregate.heatmap({
    filter,
  }) as Promise<SessionHeatmapResponse>;
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
  if (importedHistoryDescriptorForSession(record.sessionId)) {
    return "external_history";
  }
  return record.category;
}

export function toFrontendSession(record: SessionAggregateRecord): Session {
  const category = getFrontendDispatchCategory(record);
  const importedIconId = importedHistoryDescriptorForSession(
    record.sessionId
  )?.iconId;

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
    cliAgentType: record.cliAgentType,
    model: record.model,
    keySource: record.keySource,
    accountId: record.accountId,
    tier: record.tier,
    pid: record.pid ?? null,
    repoPath: record.repoPath,
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
    agentIconId: importedIconId ?? record.agentIconId,
    agentDisplayName: record.agentDisplayName,
    agentExecMode: normalizeAgentExecMode(record.agentExecMode) ?? undefined,
    draftText: record.draftText,
    replyTargetEventId: record.replyTargetEventId,
    pinned: record.pinned,
    filesChanged: record.filesChanged,
    linesAdded: record.linesAdded,
    linesRemoved: record.linesRemoved,
    touchedFiles: record.touchedFiles,
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
