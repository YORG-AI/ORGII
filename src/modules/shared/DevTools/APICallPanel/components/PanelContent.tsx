// ============================================
// PanelContent Component
// ============================================
import React, { useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";

import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  UnfoldMoreIcon,
} from "@src/icons";
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

type ApiCallSortKey =
  | "method"
  | "target"
  | "time"
  | "trigger"
  | "status"
  | "component";
type SortDirection = "asc" | "desc";

interface ApiCallSort {
  key: ApiCallSortKey;
  direction: SortDirection;
}

const API_CALL_GRID_TEMPLATE =
  "28px minmax(70px, 0.7fr) minmax(220px, 3fr) repeat(4, minmax(90px, 1fr))";

function compareApiCalls(
  callA: ApiCall,
  callB: ApiCall,
  key: ApiCallSortKey
): number {
  switch (key) {
    case "method":
      return callA.method.localeCompare(callB.method);
    case "target":
      return getApiCallTarget(callA).localeCompare(getApiCallTarget(callB));
    case "time":
      return (
        new Date(callA.timestamp).getTime() -
        new Date(callB.timestamp).getTime()
      );
    case "trigger":
      return (callA.interactionType ?? "auto").localeCompare(
        callB.interactionType ?? "auto"
      );
    case "status":
      return (
        (callA.status ?? (callA.error ? 500 : 0)) -
        (callB.status ?? (callB.error ? 500 : 0))
      );
    case "component":
      return (callA.componentName ?? "").localeCompare(
        callB.componentName ?? ""
      );
  }
}

export function sortApiCalls(
  calls: ApiCall[],
  sort: ApiCallSort | null
): ApiCall[] {
  if (!sort) return calls;
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...calls].sort(
    (callA, callB) => compareApiCalls(callA, callB, sort.key) * direction
  );
}

const ApiCallStatus: React.FC<{ call: ApiCall }> = ({ call }) => {
  const statusInfo = getStatusInfo(call.status, call.error, call.duration);
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
        ? "animate-pulse bg-warning-6"
        : "bg-success-6";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${statusToneClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`} />
      {statusInfo.label}
    </span>
  );
};

interface ApiCallRowProps {
  call: ApiCall;
  expanded: boolean;
  first: boolean;
  onToggle: () => void;
}

const ApiCallRow: React.FC<ApiCallRowProps> = ({
  call,
  expanded,
  first,
  onToggle,
}) => (
  <div
    className={`min-w-[780px] border-b border-border-2 ${first ? "bg-primary-6/10" : "bg-bg-2"}`}
  >
    <div
      className="grid min-h-8 items-center hover:bg-fill-1"
      style={{ gridTemplateColumns: API_CALL_GRID_TEMPLATE }}
    >
      <button
        type="button"
        className="flex h-full items-center justify-center text-text-3"
        aria-label={expanded ? "Collapse API call" : "Expand API call"}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {expanded ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            data-icon="chevron-down"
            size={13}
          />
        ) : (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            data-icon="chevron-right"
            size={13}
          />
        )}
      </button>
      <span className="truncate px-2 text-[11px] text-text-2">
        {call.method}
      </span>
      <button
        type="button"
        className="block overflow-hidden text-ellipsis whitespace-nowrap px-2 text-left text-[11px] text-primary-6"
        onClick={onToggle}
        title={call.fullUrl}
      >
        {call.transport === "tauri"
          ? getApiCallTarget(call)
          : formatApiUrl(call.fullUrl)}
      </button>
      <span className="truncate px-2 text-[11px] text-text-2">
        {formatTime(call.timestamp)}
      </span>
      <span className="truncate px-2 text-[11px] text-text-2">
        {getTriggerLabel(call.interactionType)}
      </span>
      <span className="truncate px-2">
        <ApiCallStatus call={call} />
      </span>
      <span
        className="truncate px-2 text-[11px] text-text-2"
        title={call.filePath || call.componentName}
      >
        {call.componentName
          ? `${call.componentName}${call.lineNumber ? `:${call.lineNumber}` : ""}`
          : "—"}
      </span>
    </div>
    {expanded && (
      <div className="border-t border-border-2 bg-bg-3 px-4 py-3">
        <ApiCallDetails call={call} />
      </div>
    )}
  </div>
);

interface SortHeaderProps {
  label: string;
  column: ApiCallSortKey;
  sort: ApiCallSort | null;
  onSort: (column: ApiCallSortKey) => void;
}

const SortHeader: React.FC<SortHeaderProps> = ({
  label,
  column,
  sort,
  onSort,
}) => (
  <button
    type="button"
    className="flex h-full min-w-0 items-center gap-1 px-2 text-left text-[10px] font-semibold uppercase tracking-wide text-text-3 hover:text-text-1"
    onClick={() => onSort(column)}
  >
    <span className="truncate">{label}</span>
    <HugeiconsIcon
      icon={UnfoldMoreIcon}
      data-icon="chevrons-up-down"
      size={11}
      className={sort?.key === column ? "text-primary-6" : "opacity-50"}
      aria-hidden
    />
  </button>
);

const PanelContent: React.FC<PanelContentProps> = ({
  apiCalls,
  hotspots,
  timerHotspots,
  pushHotspots,
  expandedCall,
  onToggleExpand,
}) => {
  const [sort, setSort] = useState<ApiCallSort | null>(null);
  const sortedCalls = useMemo(
    () => sortApiCalls(apiCalls, sort),
    [apiCalls, sort]
  );

  const handleSort = (column: ApiCallSortKey) => {
    setSort((current) => {
      if (current?.key !== column) return { key: column, direction: "asc" };
      if (current.direction === "asc")
        return { key: column, direction: "desc" };
      return null;
    });
  };

  if (
    apiCalls.length === 0 &&
    timerHotspots.length === 0 &&
    pushHotspots.length === 0
  ) {
    return <EmptyState />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="max-h-[45%] shrink-0 overflow-auto">
        <TimerHotspotSummary hotspots={timerHotspots} />
        <HotspotSummary hotspots={hotspots} />
        <PushTrafficSummary hotspots={pushHotspots} />
      </div>
      {apiCalls.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-x-auto">
          <div className="flex h-full min-w-[780px] flex-col">
            <div
              className="grid h-8 shrink-0 border-b border-border-2 bg-bg-3"
              style={{ gridTemplateColumns: API_CALL_GRID_TEMPLATE }}
            >
              <span aria-hidden />
              <SortHeader
                label="Method"
                column="method"
                sort={sort}
                onSort={handleSort}
              />
              <SortHeader
                label="Target"
                column="target"
                sort={sort}
                onSort={handleSort}
              />
              <SortHeader
                label="Time"
                column="time"
                sort={sort}
                onSort={handleSort}
              />
              <SortHeader
                label="Trigger"
                column="trigger"
                sort={sort}
                onSort={handleSort}
              />
              <SortHeader
                label="Status"
                column="status"
                sort={sort}
                onSort={handleSort}
              />
              <SortHeader
                label="Component"
                column="component"
                sort={sort}
                onSort={handleSort}
              />
            </div>
            <Virtuoso
              className="min-h-0 flex-1"
              data={sortedCalls}
              computeItemKey={(_index, call) => call.id}
              increaseViewportBy={160}
              itemContent={(index, call) => (
                <ApiCallRow
                  call={call}
                  first={index === 0}
                  expanded={expandedCall === call.id}
                  onToggle={() => onToggleExpand(call.id)}
                />
              )}
            />
          </div>
        </div>
      ) : (
        <div className="px-4 py-8 text-center text-[12px] text-text-3">
          No API calls captured yet. Timer activity is shown above.
        </div>
      )}
    </div>
  );
};

export default PanelContent;
