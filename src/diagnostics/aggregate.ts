import { getVersion } from "@tauri-apps/api/app";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import {
  detectLocalModelHardware,
  getProcessMetrics,
} from "@src/api/tauri/perf/metrics";
import type { LocalModelHardwareSummary } from "@src/api/tauri/perf/types";
import { sessionAggregateList } from "@src/api/tauri/session";
import { listRecentWorkspaces } from "@src/services/workspace/WorkspaceService";
import type { Session } from "@src/store/session/sessionAtom";
import type { WorkspaceFolder } from "@src/types/workspace";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import {
  bucketCpuCores,
  bucketCpuPercent,
  bucketDurationMs,
  bucketOsVersion,
  bucketRamMb,
  bucketTotalRamGb,
} from "./buckets";
import {
  consumeHttpDiagnosticsSummary,
  consumeRpcDiagnosticsSummary,
} from "./runtimeCounters";
import { DIAGNOSTICS_LEVEL } from "./types";
import type {
  DiagnosticsAppResourceUsage,
  DiagnosticsExternalToolUsageEntry,
  DiagnosticsLevel,
  DiagnosticsModelUsageEntry,
  DiagnosticsRustAgentTopSessionEntry,
  DiagnosticsSystemProfile,
  DiagnosticsTopModelEntry,
  DiagnosticsUsageSnapshot,
} from "./types";

const SCHEMA_VERSION = 1;
const MAX_TOP_MODELS = 10;
const MAX_RUST_AGENT_TOP_SESSIONS_PER_DAY = 10;
const EXTERNAL_HISTORY_LIMIT = 200;
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function isWithinPeriod(
  value: string | undefined,
  periodStartMs: number,
  periodEndMs: number
): boolean {
  const parsed = parseTime(value);
  return parsed !== null && parsed >= periodStartMs && parsed < periodEndMs;
}

function normalizeOsFamily(osName: string | undefined): string {
  const value = (osName ?? "").toLowerCase();
  if (value.includes("mac") || value.includes("darwin")) return "darwin";
  if (value.includes("windows")) return "windows";
  if (value.includes("linux")) return "linux";
  return "unknown";
}

function normalizeArch(chipType: string | undefined): string {
  const value = (chipType ?? "").toLowerCase();
  if (value.includes("arm") || value.includes("apple silicon")) return "arm64";
  if (value.includes("x86_64") || value.includes("x64")) return "x64";
  if (value.includes("x86")) return "x86";
  return "unknown";
}

function durationForSession(session: Session): number | null {
  const start = parseTime(session.created_at ?? session.created_time);
  const end = parseTime(
    session.completed_at ?? session.updated_at ?? session.updated_time
  );
  if (start === null || end === null || end < start) return null;
  return end - start;
}

function collectMinimalUsageMetrics(
  sessions: Session[],
  periodStartMs: number,
  periodEndMs: number,
  knownWorkspaceCount: number
): Pick<DiagnosticsUsageSnapshot, "sessions" | "workspaces"> {
  const periodSessions = sessions.filter((session) =>
    isWithinPeriod(
      session.created_at ?? session.created_time,
      periodStartMs,
      periodEndMs
    )
  );
  const byDispatchCategory: NonNullable<
    DiagnosticsUsageSnapshot["sessions"]
  >["byDispatchCategory"] = {};
  const workspaceCountedPaths = new Set<string>();
  let completed = 0;
  let failed = 0;

  for (const session of periodSessions) {
    const category = session.category ?? "cli_agent";
    byDispatchCategory[category] = (byDispatchCategory[category] ?? 0) + 1;
    if (session.status === "completed") completed += 1;
    if (session.status === "failed" || session.status === "error") failed += 1;
    if (session.repoPath) workspaceCountedPaths.add(session.repoPath);
  }

  return {
    sessions: {
      total: periodSessions.length,
      completed,
      failed,
      byDispatchCategory,
    },
    workspaces: {
      distinctUsedInPeriod: Math.max(
        workspaceCountedPaths.size,
        knownWorkspaceCount
      ),
      totalKnown: Math.max(
        new Set([
          ...workspaceCountedPaths,
          ...listRecentWorkspaces().map((workspace) => workspace.path),
        ]).size,
        knownWorkspaceCount
      ),
    },
  };
}

function collectSessionMetrics(
  sessions: Session[],
  periodStartMs: number,
  periodEndMs: number
): Pick<
  DiagnosticsUsageSnapshot,
  | "sessions"
  | "workspaces"
  | "modelUsage"
  | "topModelsByRunCount"
  | "rustAgentTopSessionsByDuration"
> {
  const periodSessions = sessions.filter((session) =>
    isWithinPeriod(
      session.created_at ?? session.created_time,
      periodStartMs,
      periodEndMs
    )
  );

  const byDispatchCategory: NonNullable<
    DiagnosticsUsageSnapshot["sessions"]
  >["byDispatchCategory"] = {};
  const workspaceCountedPaths = new Set<string>();
  const modelUsage = new Map<string, DiagnosticsModelUsageEntry>();
  const rustSessionCandidates: DiagnosticsRustAgentTopSessionEntry[] = [];

  let completed = 0;
  let failed = 0;

  for (const session of periodSessions) {
    const category = session.category ?? "cli_agent";
    byDispatchCategory[category] = (byDispatchCategory[category] ?? 0) + 1;

    if (session.status === "completed") completed += 1;
    if (session.status === "failed" || session.status === "error") failed += 1;

    if (session.repoPath) workspaceCountedPaths.add(session.repoPath);

    if (session.model) {
      const modelKey = `${session.keySource ?? "unknown"}:${session.model}`;
      const existing = modelUsage.get(modelKey) ?? {
        keySource: session.keySource,
        model: session.model,
        sessionCount: 0,
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      };
      existing.sessionCount += 1;
      existing.runCount += 1;
      if (session.status === "completed") existing.successCount += 1;
      if (session.status === "failed" || session.status === "error") {
        existing.failureCount += 1;
      }
      modelUsage.set(modelKey, existing);
    }

    if (category === "rust_agent") {
      const durationMs = durationForSession(session);
      if (durationMs !== null) {
        const localDate = new Date(
          parseTime(session.created_at ?? session.created_time) ?? periodStartMs
        )
          .toISOString()
          .slice(0, 10);
        rustSessionCandidates.push({
          localDate,
          rank: 0,
          rustAgentType: getRustAgentType(session.session_id) ?? "unknown",
          agentExecMode: session.agentExecMode,
          durationMs,
          durationBucket: bucketDurationMs(durationMs),
          status: session.status,
        });
      }
    }
  }

  const modelUsageEntries = [...modelUsage.values()];
  const topModelsByRunCount: DiagnosticsTopModelEntry[] = modelUsageEntries
    .slice()
    .sort((left, right) => right.runCount - left.runCount)
    .slice(0, MAX_TOP_MODELS)
    .map((entry, index) => ({
      rank: index + 1,
      modelType: entry.modelType,
      model: entry.model,
      runCount: entry.runCount,
      sessionCount: entry.sessionCount,
    }));

  const rustAgentTopSessionsByDuration = rustSessionCandidates
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, MAX_RUST_AGENT_TOP_SESSIONS_PER_DAY)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return {
    sessions: {
      total: periodSessions.length,
      completed,
      failed,
      byDispatchCategory,
    },
    workspaces: {
      distinctUsedInPeriod: workspaceCountedPaths.size,
      totalKnown: new Set([
        ...workspaceCountedPaths,
        ...listRecentWorkspaces().map((workspace) => workspace.path),
      ]).size,
    },
    modelUsage: modelUsageEntries,
    topModelsByRunCount,
    rustAgentTopSessionsByDuration,
  };
}

async function collectExternalToolUsage(
  periodStartMs: number,
  periodEndMs: number
): Promise<DiagnosticsExternalToolUsageEntry[]> {
  const rowsBySource = await Promise.all(
    IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(async (source) => {
      try {
        const page = await sessionAggregateList({
          category: "external_history",
          externalHistorySource: source.sourceId,
          includeExternalHistory: true,
          limit: EXTERNAL_HISTORY_LIMIT,
        });
        const periodRows = page.sessions.filter((session) =>
          isWithinPeriod(session.createdAt, periodStartMs, periodEndMs)
        );
        const durations = periodRows
          .map((session) => {
            const start = parseTime(session.createdAt);
            const end = parseTime(session.updatedAt);
            return start !== null && end !== null && end >= start
              ? end - start
              : null;
          })
          .filter((duration): duration is number => duration !== null);

        const averageDuration =
          durations.length === 0
            ? 0
            : durations.reduce((sum, duration) => sum + duration, 0) /
              durations.length;

        return {
          sourceId: source.sourceId,
          sessionCount: periodRows.length,
          durationBucket: bucketDurationMs(averageDuration),
        } satisfies DiagnosticsExternalToolUsageEntry;
      } catch {
        return {
          sourceId: source.sourceId,
          sessionCount: 0,
          durationBucket: "unknown",
        } satisfies DiagnosticsExternalToolUsageEntry;
      }
    })
  );

  return rowsBySource;
}

async function collectSystemProfile(): Promise<{
  systemProfile?: DiagnosticsSystemProfile;
  appResourceUsage?: DiagnosticsAppResourceUsage;
}> {
  const [hardware, processMetrics] = await Promise.all([
    detectLocalModelHardware().catch(
      (): LocalModelHardwareSummary | null => null
    ),
    getProcessMetrics().catch(() => null),
  ]);

  return {
    systemProfile: hardware
      ? {
          osFamily: normalizeOsFamily(hardware.os_name),
          osVersionBucket: bucketOsVersion(hardware.os_version),
          arch: normalizeArch(hardware.chip_type),
          cpuCoreBucket: bucketCpuCores(hardware.cpu_cores),
          totalRamBucket: bucketTotalRamGb(hardware.total_ram_gb),
        }
      : undefined,
    appResourceUsage: processMetrics
      ? {
          appAvgRamBucket: bucketRamMb(processMetrics.memory_rss_mb),
          appPeakRamBucket: bucketRamMb(processMetrics.memory_rss_mb),
          appAvgCpuBucket: bucketCpuPercent(processMetrics.cpu_percent),
          uptimeBucket: bucketDurationMs(processMetrics.uptime_secs * 1000),
        }
      : undefined,
  };
}

export async function createDiagnosticsUsageSnapshot(input: {
  diagnosticsLevel: DiagnosticsLevel;
  sessions: Session[];
  workspaceFolders: WorkspaceFolder[];
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<DiagnosticsUsageSnapshot | null> {
  const periodEnd = input.periodEnd ?? new Date();
  const periodStart =
    input.periodStart ?? new Date(periodEnd.getTime() - TWELVE_HOURS_MS);
  const periodStartMs = periodStart.getTime();
  const periodEndMs = periodEnd.getTime();
  const appUsageDurationBucket = bucketDurationMs(
    typeof performance === "undefined"
      ? periodEndMs - periodStartMs
      : performance.now()
  );
  const appVersion = await getVersion();

  const snapshot: DiagnosticsUsageSnapshot = {
    schemaVersion: SCHEMA_VERSION,
    diagnosticsLevel: input.diagnosticsLevel,
    capturedAt: periodEnd.toISOString(),
    appVersion,
    appLaunchCount: 1,
    appUsageDurationBucket,
  };

  if (input.diagnosticsLevel !== DIAGNOSTICS_LEVEL.OFF) {
    const { systemProfile, appResourceUsage } = await collectSystemProfile();
    snapshot.systemProfile = systemProfile;
    snapshot.appResourceUsage = appResourceUsage;
    snapshot.rpc = consumeRpcDiagnosticsSummary();
    snapshot.http = consumeHttpDiagnosticsSummary();
  } else {
    consumeRpcDiagnosticsSummary();
    consumeHttpDiagnosticsSummary();
  }

  if (input.diagnosticsLevel === DIAGNOSTICS_LEVEL.OFF) {
    Object.assign(
      snapshot,
      collectMinimalUsageMetrics(
        input.sessions,
        periodStartMs,
        periodEndMs,
        input.workspaceFolders.length
      )
    );
    snapshot.externalTools = await collectExternalToolUsage(
      periodStartMs,
      periodEndMs
    );
  }

  if (input.diagnosticsLevel === DIAGNOSTICS_LEVEL.DEFAULT) {
    Object.assign(
      snapshot,
      collectSessionMetrics(input.sessions, periodStartMs, periodEndMs)
    );
    snapshot.externalTools = await collectExternalToolUsage(
      periodStartMs,
      periodEndMs
    );
    snapshot.topLanguages = [];
    if (input.workspaceFolders.length > 0) {
      snapshot.workspaces = {
        distinctUsedInPeriod: Math.max(
          snapshot.workspaces?.distinctUsedInPeriod ?? 0,
          input.workspaceFolders.length
        ),
        totalKnown: Math.max(
          snapshot.workspaces?.totalKnown ?? 0,
          input.workspaceFolders.length
        ),
      };
    }
  }

  return snapshot;
}
