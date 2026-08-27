import type React from "react";

import type { WebViewRuntimeDiagnostics } from "@src/hooks/perf";

export interface PtyMemoryInfo {
  session_id: string;
  pid?: number | null;
  shell: string;
  memory_mb: number;
  buffer_bytes: number;
  scrollback_lines: number;
}

export interface MemoryBreakdown {
  backend_rss_mb: number;
  tracked_backend_mb: number;
  file_cache_mb: number;
}

export interface MetricsSnapshot {
  memoryBreakdown: MemoryBreakdown | null;
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
  /** Shown even when attribution hints are collapsed. */
  alwaysVisible?: boolean;
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
