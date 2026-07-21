// ============================================
// PanelContent Component
// ============================================
import React, { useMemo } from "react";

import Table, { type TableColumn } from "@src/components/Table";
import type {
  ApiCall,
  ApiCallHotspot,
  PushHotspot,
  TimerHotspot,
} from "@src/util/monitoring/apiTracker";

import {
  formatApiUrl,
  formatDuration,
  formatTime,
  getStatusInfo,
  getTriggerLabel,
} from "../utils";
import ApiCallDetails from "./ApiCallDetails";
import EmptyState from "./EmptyState";

// ============================================
// Type Definitions
// ============================================

export interface PanelContentProps {
  apiCalls: ApiCall[];
  hotspots: ApiCallHotspot[];
  timerHotspots: TimerHotspot[];
  pushHotspots: PushHotspot[];
  expandedCall: string | null;
  onToggleExpand: (id: string) => void;
  onExpandedChange: (id: string | null) => void;
}

// ============================================
// Component
// ============================================

function getHotspotSource(hotspot: ApiCallHotspot | TimerHotspot): string {
  if (hotspot.filePath) {
    const fileName = hotspot.filePath.split("/").pop() ?? hotspot.filePath;
    return `${fileName}${hotspot.lineNumber ? `:${hotspot.lineNumber}` : ""}`;
  }
  return hotspot.componentName || hotspot.functionName || "unknown source";
}

function formatCallsPerMinute(callsPerMinute: number): string {
  if (callsPerMinute >= 10) return callsPerMinute.toFixed(0);
  return callsPerMinute.toFixed(1);
}

function getTimerLabel(hotspot: TimerHotspot): string {
  if (hotspot.kind === "raf") return "requestAnimationFrame";
  return `${hotspot.kind === "interval" ? "setInterval" : "setTimeout"}(${hotspot.delayMs ?? "?"}ms)`;
}

function getApiCallTarget(call: ApiCall): string {
  return call.transport === "tauri"
    ? call.tauriCommand || call.url
    : call.fullUrl;
}

/** Keep the compact top-six summary, but never hide a group the tracker has
 * classified as likely polling. */
export function selectVisibleApiHotspots(
  hotspots: ApiCallHotspot[]
): ApiCallHotspot[] {
  return hotspots.filter(
    (hotspot, index) => index < 6 || hotspot.isLikelyPolling
  );
}

export function selectVisibleTimerHotspots(
  hotspots: TimerHotspot[]
): TimerHotspot[] {
  return hotspots.filter((hotspot, index) => index < 6 || hotspot.isLikelyLoop);
}

export function selectVisiblePushHotspots(
  hotspots: PushHotspot[]
): PushHotspot[] {
  return hotspots.filter(
    (hotspot, index) => index < 6 || hotspot.isLikelyStream
  );
}

const HotspotSummary: React.FC<{ hotspots: ApiCallHotspot[] }> = ({
  hotspots,
}) => {
  const topHotspots = selectVisibleApiHotspots(hotspots);
  if (topHotspots.length === 0) return null;

  return (
    <div className="border-b border-border-2 bg-bg-1/70 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-text-1">
            Polling / call hotspots
          </div>
          <div className="text-[11px] text-text-3">
            Grouped by target and source over the last 2 minutes
          </div>
        </div>
        <div className="text-[11px] text-text-3">
          {hotspots.filter((hotspot) => hotspot.isLikelyPolling).length} likely
          polling
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
        {topHotspots.map((hotspot) => (
          <div
            key={hotspot.key}
            className={`rounded-lg border p-2.5 ${
              hotspot.isLikelyPolling
                ? "border-warning-6/40 bg-warning-6/10"
                : "border-border-2 bg-bg-2"
            }`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-3">
                {hotspot.transport === "tauri" ? "IPC" : "HTTP"} ·{" "}
                {hotspot.method}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  hotspot.isLikelyPolling
                    ? "bg-warning-6/15 text-warning-6"
                    : "bg-fill-2 text-text-3"
                }`}
              >
                {formatCallsPerMinute(hotspot.callsPerMinute)}/min
              </span>
            </div>
            <div
              className="truncate text-[11px] font-medium text-primary-6"
              title={hotspot.target}
            >
              {hotspot.target}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-3">
              <span
                className="truncate"
                title={hotspot.stack || hotspot.filePath || undefined}
              >
                {getHotspotSource(hotspot)}
              </span>
              <span>
                {hotspot.count} calls
                {hotspot.averageDurationMs
                  ? ` · ${formatDuration(hotspot.averageDurationMs)}`
                  : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const TimerHotspotSummary: React.FC<{ hotspots: TimerHotspot[] }> = ({
  hotspots,
}) => {
  const topHotspots = selectVisibleTimerHotspots(hotspots);
  if (topHotspots.length === 0) return null;

  return (
    <div className="border-b border-border-2 bg-bg-1/70 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-text-1">
            Timer / RAF hotspots
          </div>
          <div className="text-[11px] text-text-3">
            Captures frontend-only loops over the last 2 minutes
          </div>
        </div>
        <div className="text-[11px] text-text-3">
          {hotspots.filter((hotspot) => hotspot.isLikelyLoop).length} likely
          loops
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
        {topHotspots.map((hotspot) => (
          <div
            key={hotspot.key}
            className={`rounded-lg border p-2.5 ${
              hotspot.isLikelyLoop
                ? "border-danger-6/40 bg-danger-6/10"
                : "border-border-2 bg-bg-2"
            }`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-3">
                Frontend · {hotspot.kind.toUpperCase()}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  hotspot.isLikelyLoop
                    ? "bg-danger-6/15 text-danger-6"
                    : "bg-fill-2 text-text-3"
                }`}
              >
                {formatCallsPerMinute(hotspot.firesPerMinute)}/min
              </span>
            </div>
            <div
              className="truncate text-[11px] font-medium text-primary-6"
              title={getTimerLabel(hotspot)}
            >
              {getTimerLabel(hotspot)}
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-text-3">
              <span
                className="truncate"
                title={hotspot.stack || hotspot.filePath || undefined}
              >
                {getHotspotSource(hotspot)}
              </span>
              <span>{hotspot.count} fires</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PUSH_KIND_LABELS: Record<PushHotspot["kind"], string> = {
  "tauri-event": "Tauri event",
  channel: "IPC channel",
  ws: "WebSocket",
  sse: "SSE",
};

const PushTrafficSummary: React.FC<{ hotspots: PushHotspot[] }> = ({
  hotspots,
}) => {
  const topHotspots = selectVisiblePushHotspots(hotspots);
  if (topHotspots.length === 0) return null;

  return (
    <div className="border-b border-border-2 bg-bg-1/70 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold text-text-1">
            Event / stream traffic
          </div>
          <div className="text-[11px] text-text-3">
            Events delivered to the frontend (Tauri events, channels, WS, SSE)
            over the last 2 minutes
          </div>
        </div>
        <div className="text-[11px] text-text-3">
          {hotspots.filter((hotspot) => hotspot.isLikelyStream).length} active
          streams
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 xl:grid-cols-3">
        {topHotspots.map((hotspot) => (
          <div
            key={hotspot.key}
            className={`rounded-lg border p-2.5 ${
              hotspot.isLikelyStream
                ? "border-primary-6/40 bg-primary-6/10"
                : "border-border-2 bg-bg-2"
            }`}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-text-3">
                {PUSH_KIND_LABELS[hotspot.kind]}
              </span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  hotspot.isLikelyStream
                    ? "bg-primary-6/15 text-primary-6"
                    : "bg-fill-2 text-text-3"
                }`}
              >
                {formatCallsPerMinute(hotspot.eventsPerMinute)}/min
              </span>
            </div>
            <div
              className="truncate text-[11px] font-medium text-primary-6"
              title={hotspot.name}
            >
              {hotspot.name}
            </div>
            <div className="mt-1 text-right text-[10px] text-text-3">
              {hotspot.count} events
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const PanelContent: React.FC<PanelContentProps> = ({
  apiCalls,
  hotspots,
  timerHotspots,
  pushHotspots,
  expandedCall,
  onToggleExpand,
  onExpandedChange,
}) => {
  const columns = useMemo<TableColumn<ApiCall>[]>(
    () => [
      {
        key: "method",
        dataIndex: "method",
        title: "Method",
        width: "10%",
        sorter: (callA, callB) => callA.method.localeCompare(callB.method),
        render: (_value, call) => (
          <span className="text-[11px] text-text-2">{call.method}</span>
        ),
      },
      {
        key: "target",
        dataIndex: "url",
        title: "Target",
        width: "42%",
        sorter: (callA, callB) =>
          getApiCallTarget(callA).localeCompare(getApiCallTarget(callB)),
        render: (_value, call) => (
          <button
            type="button"
            className="block w-full overflow-hidden text-ellipsis whitespace-nowrap text-left text-[11px] text-primary-6"
            onClick={() => onToggleExpand(call.id)}
            title={call.fullUrl}
          >
            {call.transport === "tauri"
              ? getApiCallTarget(call)
              : formatApiUrl(call.fullUrl)}
          </button>
        ),
      },
      {
        key: "time",
        dataIndex: "timestamp",
        title: "Time",
        width: "12%",
        sorter: (callA, callB) =>
          new Date(callA.timestamp).getTime() -
          new Date(callB.timestamp).getTime(),
        render: (_value, call) => (
          <span className="text-[11px] text-text-2">
            {formatTime(call.timestamp)}
          </span>
        ),
      },
      {
        key: "trigger",
        dataIndex: "interactionType",
        title: "Trigger",
        width: "12%",
        sorter: (callA, callB) =>
          (callA.interactionType ?? "auto").localeCompare(
            callB.interactionType ?? "auto"
          ),
        render: (_value, call) => (
          <span className="text-[11px] text-text-2">
            {getTriggerLabel(call.interactionType)}
          </span>
        ),
      },
      {
        key: "status",
        dataIndex: "status",
        title: "Status",
        width: "12%",
        sorter: (callA, callB) => {
          const statusA = callA.status ?? (callA.error ? 500 : 0);
          const statusB = callB.status ?? (callB.error ? 500 : 0);
          return statusA - statusB;
        },
        render: (_value, call) => {
          const statusInfo = getStatusInfo(
            call.status,
            call.error,
            call.duration
          );
          const statusToneClass =
            statusInfo.class === "status-error"
              ? "text-danger-6"
              : statusInfo.class === "status-pending"
                ? "text-warning-6"
                : "text-success-6";
          const statusDotClass =
            statusInfo.class === "status-error"
              ? "bg-danger-6"
              : statusInfo.class === "status-pending"
                ? "bg-warning-6 animate-pulse"
                : "bg-success-6";
          return (
            <span
              className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${statusToneClass}`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
              {statusInfo.label}
            </span>
          );
        },
      },
      {
        key: "component",
        dataIndex: "componentName",
        title: "Component",
        width: "12%",
        sorter: (callA, callB) =>
          (callA.componentName ?? "").localeCompare(callB.componentName ?? ""),
        render: (_value, call) =>
          call.componentName ? (
            <span
              className="text-[11px] text-text-2"
              title={call.filePath || call.componentName}
            >
              {call.componentName}
              {call.lineNumber ? `:${call.lineNumber}` : ""}
            </span>
          ) : (
            <span className="text-[11px] text-text-4">—</span>
          ),
      },
    ],
    [onToggleExpand]
  );

  const expandable = useMemo(
    () => ({
      expandedRowRender: (call: ApiCall) => (
        <div className="border-t border-border-2 bg-bg-3 px-4 py-3">
          <ApiCallDetails call={call} />
        </div>
      ),
      expandedRowKeys: expandedCall ? [expandedCall] : [],
      onExpandedRowsChange: (keys: string[]) => {
        onExpandedChange(keys[0] ?? null);
      },
    }),
    [expandedCall, onExpandedChange]
  );

  if (
    apiCalls.length === 0 &&
    timerHotspots.length === 0 &&
    pushHotspots.length === 0
  ) {
    return <EmptyState />;
  }

  return (
    <div className="flex min-h-0 flex-col">
      <TimerHotspotSummary hotspots={timerHotspots} />
      <HotspotSummary hotspots={hotspots} />
      <PushTrafficSummary hotspots={pushHotspots} />
      {apiCalls.length > 0 ? (
        <Table<ApiCall>
          columns={columns}
          data={apiCalls}
          rowKey="id"
          pagination={false}
          hover
          stripe={false}
          border={false}
          size="small"
          className="!border-0"
          expandable={expandable}
          rowClassName={(call, index) =>
            index === 0
              ? "!bg-primary-6/10 hover:!bg-fill-1"
              : "hover:!bg-fill-1"
          }
        />
      ) : (
        <div className="px-4 py-8 text-center text-[12px] text-text-3">
          No API calls captured yet. Timer activity is shown above.
        </div>
      )}
    </div>
  );
};

export default PanelContent;
