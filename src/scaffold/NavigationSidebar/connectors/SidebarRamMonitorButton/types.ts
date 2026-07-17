import type React from "react";

import type {
  ChildProcessInfo as SharedChildProcessInfo,
  MemoryBreakdown as SharedMemoryBreakdown,
  ProcessMetrics as SharedProcessMetrics,
  SystemMemoryMetrics as SharedSystemMemoryMetrics,
  WebViewRuntimeDiagnostics,
} from "@src/hooks/perf";

export type ChildProcessInfo = SharedChildProcessInfo;
export type MemoryBreakdown = SharedMemoryBreakdown;
export type ProcessMetrics = SharedProcessMetrics;
export type SystemMemoryMetrics = SharedSystemMemoryMetrics;

export const CHILD_PROCESS_CATEGORY = {
  TERMINAL: "terminal",
  WEBVIEW: "webview",
  GPU: "gpu",
  NETWORK: "network",
  OTHER: "other",
} as const;

export type ChildProcessCategory =
  (typeof CHILD_PROCESS_CATEGORY)[keyof typeof CHILD_PROCESS_CATEGORY];

export interface PtyMemoryInfo {
  session_id: string;
  pid?: number | null;
  shell: string;
  memory_mb: number;
  buffer_bytes: number;
  scrollback_lines: number;
}

export interface MetricsSnapshot {
  processMetrics: ProcessMetrics | null;
  systemMemory: SystemMemoryMetrics | null;
  memoryBreakdown: MemoryBreakdown | null;
  childProcesses: ChildProcessInfo[];
  ptyMemory: PtyMemoryInfo[];
  webViewDiagnostics: WebViewRuntimeDiagnostics | null;
  terminalBufferBytes: number;
  terminalBufferEntries: number;
  lastUpdatedAt: number | null;
  errorMessage: string | null;
}

export interface MemoryStatRowProps {
  label: React.ReactNode;
  value: React.ReactNode;
  emphasized?: boolean;
  tone?: "success" | "muted";
  indentLevel?: number;
}

export interface MemoryBreakdownRow {
  key: string;
  label: React.ReactNode;
  value: string;
  bytes: number;
  detail?: string;
  emphasized?: boolean;
  indentLevel?: number;
}

export interface SidebarRamMonitorPanelProps {
  isOpen: boolean;
  panelRef: React.RefObject<HTMLDivElement | null>;
  panelPosition: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}
