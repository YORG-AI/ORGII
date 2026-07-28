import type {
  DispatchCategory,
  KeySource,
} from "@src/api/tauri/session/dispatchTypes";

export const DIAGNOSTICS_LEVEL = {
  OFF: "off",
  PERFORMANCE_ONLY: "performance-only",
  DEFAULT: "default",
} as const;

export type DiagnosticsLevel =
  (typeof DIAGNOSTICS_LEVEL)[keyof typeof DIAGNOSTICS_LEVEL];

export interface DiagnosticsRuntimeOperationSummary {
  total: number;
  success: number;
  failure: number;
  durationBucket: string;
}

export interface DiagnosticsRuntimeSummary {
  total: number;
  success: number;
  failure: number;
  byOperation: Record<string, DiagnosticsRuntimeOperationSummary>;
}

export interface DiagnosticsModelUsageEntry {
  keySource?: KeySource;
  modelType?: string;
  model: string;
  sessionCount: number;
  runCount: number;
  successCount: number;
  failureCount: number;
}

export interface DiagnosticsTopModelEntry {
  rank: number;
  modelType?: string;
  model: string;
  runCount: number;
  sessionCount: number;
}

export interface DiagnosticsRustAgentTopSessionEntry {
  localDate: string;
  rank: number;
  rustAgentType: string;
  agentExecMode?: string;
  durationMs: number;
  durationBucket: string;
  status: string;
}

export interface DiagnosticsExternalToolUsageEntry {
  sourceId: string;
  sessionCount: number;
  durationBucket: string;
}

export interface DiagnosticsLanguageUsageEntry {
  rank: number;
  language: string;
  workspaceCount: number;
  activityBucket: string;
}

export interface DiagnosticsSystemProfile {
  osFamily: string;
  osVersionBucket: string;
  arch: string;
  cpuCoreBucket?: string;
  totalRamBucket?: string;
}

export interface DiagnosticsAppResourceUsage {
  appAvgRamBucket?: string;
  appPeakRamBucket?: string;
  appAvgCpuBucket?: string;
  uptimeBucket?: string;
}

export interface DiagnosticsUsageSnapshot {
  schemaVersion: number;
  diagnosticsLevel: DiagnosticsLevel;
  capturedAt: string;
  appVersion?: string;
  appLaunchCount: number;
  appUsageDurationBucket?: string;
  systemProfile?: DiagnosticsSystemProfile;
  appResourceUsage?: DiagnosticsAppResourceUsage;
  sessions?: {
    total: number;
    completed: number;
    failed: number;
    byDispatchCategory: Partial<
      Record<DispatchCategory | "external_history", number>
    >;
  };
  workspaces?: {
    distinctUsedInPeriod: number;
    totalKnown: number;
  };
  modelUsage?: DiagnosticsModelUsageEntry[];
  topModelsByRunCount?: DiagnosticsTopModelEntry[];
  rustAgentTopSessionsByDuration?: DiagnosticsRustAgentTopSessionEntry[];
  externalTools?: DiagnosticsExternalToolUsageEntry[];
  topLanguages?: DiagnosticsLanguageUsageEntry[];
  rpc?: DiagnosticsRuntimeSummary;
  http?: DiagnosticsRuntimeSummary;
}

export interface DiagnosticsServiceConfig {
  diagnosticsLevel: DiagnosticsLevel;
  offlineMode: boolean;
}
