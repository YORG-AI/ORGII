/**
 * NetworkTab Component
 *
 * Displays network request entries with filtering capabilities.
 */
import React, { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import { BrushCleaningIcon, HugeiconsIcon } from "@src/icons";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/modules/WorkStation/shared/tokens";

import type {
  NetworkEntry,
  NetworkFilterStatus,
  NetworkFilterType,
} from "../../types";

// ============================================
// Types
// ============================================

interface NetworkTabProps {
  entries: NetworkEntry[];
  onClear: () => void;
}

// ============================================
// Helper Functions
// ============================================

function getStatusColor(status: number | null, error: string | null): string {
  if (error) return "text-danger-6";
  if (!status) return "text-text-3";
  if (status >= 200 && status < 300) return "text-success-6";
  if (status >= 300 && status < 400) return "text-warning-6";
  if (status >= 400) return "text-danger-6";
  return "text-text-2";
}

function formatDuration(duration: number | null): string {
  if (duration === null) return "...";
  if (duration < 1000) return `${duration}ms`;
  return `${(duration / 1000).toFixed(2)}s`;
}

function formatSize(size: string | null): string {
  if (!size) return "-";
  const bytes = parseInt(size, 10);
  if (isNaN(bytes)) return size;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function extractUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

// ============================================
// Component
// ============================================

export const NetworkTab: React.FC<NetworkTabProps> = memo(
  ({ entries, onClear }) => {
    const { t } = useTranslation();
    const [searchQuery, setSearchQuery] = useState("");
    const [filterStatus, setFilterStatus] =
      useState<NetworkFilterStatus>("all");
    const [filterType, setFilterType] = useState<NetworkFilterType>("all");

    const filteredEntries = useMemo(() => {
      let result = entries;

      // Filter by type
      if (filterType !== "all") {
        result = result.filter((entry) => entry.type === filterType);
      }

      // Filter by status
      if (filterStatus !== "all") {
        result = result.filter((entry) => {
          if (filterStatus === "failed") return entry.error !== null;
          if (!entry.status) return false;
          const statusPrefix = filterStatus.slice(0, 1);
          return String(entry.status).startsWith(statusPrefix);
        });
      }

      // Filter by search
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        result = result.filter((entry) =>
          entry.url.toLowerCase().includes(query)
        );
      }

      return result;
    }, [entries, filterType, filterStatus, searchQuery]);

    return (
      <div className="flex h-full min-w-0 flex-col">
        {/* Toolbar */}
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border-1 px-3 py-1.5">
          {/* Search input */}
          <div className="min-w-0 flex-1">
            <Input
              size="small"
              placeholder={t("placeholders.filterByUrl")}
              value={searchQuery}
              onChange={(value) => setSearchQuery(value)}
              allowClear
              className="devtools-input input-pane-surface"
            />
          </div>

          {/* Type filter */}
          <Select
            size="small"
            value={filterType}
            onChange={(value) => setFilterType(value as NetworkFilterType)}
            options={[
              { label: "All", value: "all" },
              { label: "Fetch", value: "fetch" },
              { label: "XHR", value: "xhr" },
            ]}
            className="devtools-select w-16 shrink-0"
            dropdownWidthMode="auto"
          />

          {/* Status filter */}
          <Select
            size="small"
            value={filterStatus}
            onChange={(value) => setFilterStatus(value as NetworkFilterStatus)}
            options={[
              { label: "All", value: "all" },
              { label: "2xx", value: "2xx" },
              { label: "3xx", value: "3xx" },
              { label: "4xx", value: "4xx" },
              { label: "5xx", value: "5xx" },
              { label: "Failed", value: "failed" },
            ]}
            className="devtools-select w-16 shrink-0"
            dropdownWidthMode="auto"
          />

          {/* Clear button */}
          <ToolbarTooltip label={t("tooltips.clearNetworkLogs")}>
            <button
              type="button"
              onClick={onClear}
              className={HEADER_BUTTON.actionTreeRow}
              aria-label={t("tooltips.clearNetworkLogs")}
            >
              <HugeiconsIcon
                icon={BrushCleaningIcon}
                data-icon="brush-cleaning"
                size={HEADER_ICON_SIZE.sm}
              />
            </button>
          </ToolbarTooltip>
        </div>

        {/* Entries */}
        <div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          {filteredEntries.length === 0 ? (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t("placeholders.noRequests")}
              fillParentHeight
            />
          ) : (
            filteredEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex max-w-full min-w-0 cursor-default items-center gap-2 border-b border-border-1 px-3 py-1 text-[11px] hover:bg-fill-1"
              >
                <span className="w-10 shrink-0 font-medium text-text-2">
                  {entry.method}
                </span>
                <span
                  className={`w-10 shrink-0 font-medium ${getStatusColor(entry.status, entry.error)}`}
                >
                  {entry.error ? "ERR" : (entry.status ?? "...")}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-text-2"
                  title={entry.url}
                >
                  {extractUrlPath(entry.url)}
                </span>
                <span className="w-12 shrink-0 text-right text-text-3">
                  {formatDuration(entry.duration)}
                </span>
                <span className="w-12 shrink-0 text-right text-text-3">
                  {formatSize(entry.size)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }
);

NetworkTab.displayName = "NetworkTab";

export default NetworkTab;
