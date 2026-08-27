/**
 * Shared presentational pieces for McpTable:
 *   - McpTableSkeleton  — loading placeholder rows
 *   - StatusChip        — coloured status pill
 *   - statusDotColor    — status → Tailwind bg class
 *   - formatUptime      — connected_at ms → short human label
 *
 * Extracted to keep McpTable.tsx under the UI component line limit.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { SETTINGS_TABLE_CELL } from "@src/components/SettingsTable";
import StatusDot from "@src/components/StatusDot";
import Switch from "@src/components/Switch";
import type {
  McpConnectionStatus,
  McpServerStatus,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";

// ── Constants ────────────────────────────────────────────────────────────────

const SKELETON_ROW_COUNT = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Backend status → Tailwind dot colour class.
 *  `disabled` is neutral (user opted out);
 *  `disconnected` is warning (server should be running but isn't). */
export function statusDotColor(status: McpConnectionStatus): string {
  switch (status) {
    case "connected":
      return "bg-success-6";
    case "error":
      return "bg-danger-6";
    case "needsAuth":
      return "bg-warning-6";
    case "connecting":
      return "bg-primary-6";
    case "disabled":
      return "bg-fill-4";
    default:
      return "bg-fill-3";
  }
}

/** Format `connected_at` as a short, human-readable uptime suffix
 *  (e.g. "2m", "1h"). Intentionally coarse — the detail drawer shows the
 *  exact timestamp. */
export function formatUptime(connectedAtMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - connectedAtMs);
  const seconds = Math.floor(delta / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

export const McpTableSkeleton: React.FC = () => (
  <div className="flex flex-col gap-2">
    {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
      <div
        key={i}
        className="flex animate-pulse items-center gap-4 rounded-md px-3 py-3"
      >
        <div className="h-4 w-32 rounded bg-fill-2" />
        <div className="h-4 w-16 rounded bg-fill-2" />
        <div className="ml-auto h-3 w-3 rounded-full bg-fill-2" />
      </div>
    ))}
  </div>
);

export function StatusChip({ status }: { status: McpConnectionStatus }) {
  const { t } = useTranslation("integrations");
  const labelKey = `mcp.statusLabels.${status}`;
  const defaultLabel: Record<McpConnectionStatus, string> = {
    connected: "Connected",
    connecting: "Connecting…",
    disconnected: "Disconnected",
    error: "Error",
    needsAuth: "Auth needed",
    disabled: "Disabled",
  };
  const color = statusDotColor(status);
  const isConnecting = status === "connecting";
  return (
    <StatusDot
      color={color}
      pulse={isConnecting}
      label={t(labelKey, { defaultValue: defaultLabel[status] })}
    />
  );
}

export function McpServerNameCell({ server }: { server: McpServerStatus }) {
  return (
    <div className="flex flex-col">
      <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
        {server.name}
      </span>
      {server.error && (
        <span
          className="mt-0.5 truncate text-[11px] text-danger-6"
          title={server.error}
        >
          {server.error}
        </span>
      )}
    </div>
  );
}

export function McpTransportCell({ server }: { server: McpServerStatus }) {
  return (
    <span className={SETTINGS_TABLE_CELL.value}>{server.transportType}</span>
  );
}

export function McpToolCountCell({ server }: { server: McpServerStatus }) {
  return (
    <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
      {server.toolCount}
    </span>
  );
}

export function McpUptimeCell({
  server,
  nowMs,
}: {
  server: McpServerStatus;
  nowMs: number;
}) {
  return (
    <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
      {server.status === "connected" && server.connectedAt
        ? formatUptime(server.connectedAt, nowMs)
        : "—"}
    </span>
  );
}

export function McpEnabledSwitchCell({
  checked,
  onChange,
  dataTestId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  dataTestId?: string;
}) {
  return (
    <div
      className="flex h-full items-center justify-center"
      onClick={(event) => event.stopPropagation()}
      role="presentation"
    >
      <Switch
        size="small"
        checked={checked}
        dataTestId={dataTestId}
        onCheckedChange={onChange}
      />
    </div>
  );
}
