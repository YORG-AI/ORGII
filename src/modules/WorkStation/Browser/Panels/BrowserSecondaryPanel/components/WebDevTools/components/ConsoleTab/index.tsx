/**
 * ConsoleTab Component
 *
 * Displays console log entries with filtering and search capabilities.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Input from "@src/components/Input";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import {
  BrushCleaningIcon,
  Copy01Icon,
  HugeiconsIcon,
  Tick01Icon,
} from "@src/icons";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/modules/WorkStation/shared/tokens";
import { copyText } from "@src/util/data/clipboard";

import type { ConsoleEntry, FilterLevel, LogLevel } from "../../types";

// ============================================
// Types
// ============================================

export interface ConsoleTabProps {
  entries: ConsoleEntry[];
  onClear: () => void;
  preserveLogs?: boolean;
  onTogglePreserveLogs?: () => void;
}

// ============================================
// Helper Functions
// ============================================

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function getEntryStyles(level: LogLevel): string {
  switch (level) {
    case "error":
      return "text-danger-6 bg-danger-6/10";
    case "warn":
      return "text-warning-6 bg-warning-6/10";
    case "info":
      return "text-primary-6 bg-primary-6/5";
    case "debug":
    case "trace":
      return "text-text-3";
    default:
      return "text-text-2";
  }
}

const MAX_MESSAGE_PREVIEW_LINES = 3;
const CONSOLE_VIRTUALIZATION_THRESHOLD = 40;

function getMessagePreviewLines(
  message: string,
  maxLines: number
): { preview: string; truncated: boolean; totalLines: number } {
  const lines = message.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { preview: message, truncated: false, totalLines };
  }
  return {
    preview: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines,
  };
}

interface ConsoleLogEntryRowProps {
  entry: ConsoleEntry;
  copiedId: string | null;
  messageExpanded: boolean;
  stackExpanded: boolean;
  onToggleMessage: () => void;
  onToggleStack: () => void;
  onCopy: (event: React.MouseEvent) => void;
}

function ConsoleLogEntryRow({
  entry,
  copiedId,
  messageExpanded,
  stackExpanded,
  onToggleMessage,
  onToggleStack,
  onCopy,
}: ConsoleLogEntryRowProps) {
  const { t } = useTranslation();
  const { preview, truncated } = getMessagePreviewLines(
    entry.message,
    MAX_MESSAGE_PREVIEW_LINES
  );
  const showFullMessage = !truncated || messageExpanded;
  const displayMessage = showFullMessage ? entry.message : preview;
  const levelStyles = getEntryStyles(entry.level);

  return (
    <div
      className={`group min-w-0 max-w-full select-text border-b border-border-1 px-3 py-1.5 text-[11px] leading-relaxed hover:bg-fill-3 ${levelStyles}`}
    >
      <div className="flex w-full min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="shrink-0 text-[10px] text-text-3">
            {formatTimestamp(entry.timestamp)}
          </span>
          <span className="shrink-0 text-[10px] font-medium uppercase">
            [{entry.level}]
          </span>
        </div>
        <ToolbarTooltip label={t("tooltips.copyToClipboard")}>
          <Button
            variant="tertiary"
            size="mini"
            icon={
              copiedId === entry.id ? (
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={12}
                  className="text-success-6"
                />
              ) : (
                <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />
              )
            }
            iconOnly
            onClick={onCopy}
            aria-label={t("tooltips.copyToClipboard")}
            className="shrink-0 select-none opacity-0 group-hover:opacity-100"
          />
        </ToolbarTooltip>
      </div>

      <div className="mt-0.5 min-w-0 max-w-full">
        <div
          role={truncated ? "button" : undefined}
          tabIndex={truncated ? 0 : undefined}
          aria-expanded={truncated ? messageExpanded : undefined}
          className={
            truncated
              ? "cursor-pointer select-text whitespace-pre-wrap break-words text-left outline-none [overflow-wrap:anywhere] focus-visible:ring-1 focus-visible:ring-primary-6"
              : "select-text whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          }
          onClick={() => {
            if (!truncated) return;
            const selectionText = window.getSelection()?.toString() ?? "";
            if (selectionText.length > 0) return;
            onToggleMessage();
          }}
          onKeyDown={(event) => {
            if (!truncated) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggleMessage();
            }
          }}
        >
          {displayMessage}
        </div>

        {truncated && (
          <button
            type="button"
            className="mt-0.5 select-none text-[10px] text-primary-6 underline decoration-primary-6/50 underline-offset-2 hover:text-primary-5"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMessage();
            }}
          >
            {messageExpanded ? t("showLess") : t("showMore")}
          </button>
        )}

        {entry.stack && (
          <div className="mt-1">
            <button
              type="button"
              className="select-none text-[10px] text-primary-6 underline decoration-primary-6/50 underline-offset-2 hover:text-primary-5"
              onClick={(event) => {
                event.stopPropagation();
                onToggleStack();
              }}
            >
              {stackExpanded
                ? t("workstation.consoleHideStackTrace")
                : t("workstation.consoleShowStackTrace")}
            </button>
            {stackExpanded && (
              <pre className="mt-1 w-full select-text overflow-x-auto whitespace-pre-wrap break-all rounded bg-bg-3 px-3 py-1.5 text-[10px] leading-relaxed text-text-2">
                {entry.stack}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Component
// ============================================

export const ConsoleTab: React.FC<ConsoleTabProps> = memo(
  ({ entries, onClear, preserveLogs, onTogglePreserveLogs }) => {
    const { t } = useTranslation();
    const [filterLevel, setFilterLevel] = useState<FilterLevel>("all");
    const [searchQuery, setSearchQuery] = useState("");
    const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
      new Set()
    );
    const [expandedStackIds, setExpandedStackIds] = useState<Set<string>>(
      new Set()
    );
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mountedRef = useRef(true);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      };
    }, []);

    // Filter entries by level and search query
    const filteredEntries = useMemo(() => {
      let result = entries;

      // Filter by level
      if (filterLevel !== "all") {
        result = result.filter((entry) => entry.level === filterLevel);
      }

      // Filter by search query
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        result = result.filter(
          (entry) =>
            entry.message.toLowerCase().includes(query) ||
            entry.url.toLowerCase().includes(query) ||
            (entry.stack && entry.stack.toLowerCase().includes(query))
        );
      }

      return result;
    }, [entries, filterLevel, searchQuery]);
    const retainedEntryIds = useMemo(
      () => new Set(entries.map((entry) => entry.id)),
      [entries]
    );

    const toggleMessageExpanded = useCallback(
      (id: string) => {
        setExpandedMessageIds((prev) => {
          const next = new Set(
            [...prev].filter((entryId) => retainedEntryIds.has(entryId))
          );
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      },
      [retainedEntryIds]
    );

    const toggleStackExpanded = useCallback(
      (id: string) => {
        setExpandedStackIds((prev) => {
          const next = new Set(
            [...prev].filter((entryId) => retainedEntryIds.has(entryId))
          );
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      },
      [retainedEntryIds]
    );

    // Copy entry to clipboard
    const handleCopyEntry = useCallback(
      (entry: ConsoleEntry, event: React.MouseEvent) => {
        event.stopPropagation();
        const text = `[${entry.level.toUpperCase()}] ${formatTimestamp(entry.timestamp)}\n${entry.message}${entry.stack ? `\n\nStack:\n${entry.stack}` : ""}`;
        void copyText(text).then(() => {
          if (!mountedRef.current) return;
          setCopiedId(entry.id);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => {
            copiedTimerRef.current = null;
            if (mountedRef.current) setCopiedId(null);
          }, 1500);
        });
      },
      []
    );

    const renderEntry = useCallback(
      (entry: ConsoleEntry) => (
        <ConsoleLogEntryRow
          entry={entry}
          copiedId={copiedId}
          messageExpanded={expandedMessageIds.has(entry.id)}
          stackExpanded={expandedStackIds.has(entry.id)}
          onToggleMessage={() => toggleMessageExpanded(entry.id)}
          onToggleStack={() => toggleStackExpanded(entry.id)}
          onCopy={(event) => handleCopyEntry(entry, event)}
        />
      ),
      [
        copiedId,
        expandedMessageIds,
        expandedStackIds,
        handleCopyEntry,
        toggleMessageExpanded,
        toggleStackExpanded,
      ]
    );

    const handleClear = useCallback(() => {
      setExpandedMessageIds(new Set());
      setExpandedStackIds(new Set());
      setCopiedId(null);
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      onClear();
    }, [onClear]);

    return (
      <div className="flex h-full min-w-0 flex-col">
        {/* Toolbar */}
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b border-border-1 px-3 py-1.5">
          {/* Search input */}
          <div className="min-w-0 flex-1">
            <Input
              size="small"
              placeholder={t("placeholders.filterLogs")}
              value={searchQuery}
              onChange={(value) => setSearchQuery(value)}
              allowClear
              className="devtools-input input-pane-surface"
            />
          </div>

          {/* Level filter */}
          <Select
            size="small"
            value={filterLevel}
            onChange={(value) => setFilterLevel(value as FilterLevel)}
            options={[
              { label: "All", value: "all" },
              { label: "Errors", value: "error" },
              { label: "Warnings", value: "warn" },
              { label: "Info", value: "info" },
              { label: "Log", value: "log" },
              { label: "Debug", value: "debug" },
            ]}
            className="devtools-select w-20 shrink-0"
            dropdownWidthMode="auto"
          />

          {/* Preserve logs toggle */}
          {onTogglePreserveLogs && (
            <Checkbox
              checked={preserveLogs}
              onCheckedChange={onTogglePreserveLogs}
              size="mini"
              className="shrink-0"
            >
              <span className="text-[10px] text-text-3">
                {t("workstation.preserveConsole")}
              </span>
            </Checkbox>
          )}

          {/* Clear button */}
          <ToolbarTooltip label={t("tooltips.clearConsole")}>
            <button
              type="button"
              onClick={handleClear}
              className={HEADER_BUTTON.actionTreeRow}
              aria-label={t("tooltips.clearConsole")}
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
        <div className="min-w-0 flex-1 select-text overflow-hidden py-1">
          {filteredEntries.length === 0 ? (
            <Placeholder
              variant="empty"
              placement="sidebar"
              title={t("placeholders.noOutput")}
              fillParentHeight
            />
          ) : filteredEntries.length > CONSOLE_VIRTUALIZATION_THRESHOLD ? (
            <Virtuoso
              className="h-full overflow-x-hidden"
              data={filteredEntries}
              computeItemKey={(_index, entry) => entry.id}
              increaseViewportBy={200}
              itemContent={(_index, entry) => renderEntry(entry)}
            />
          ) : (
            <div className="h-full overflow-y-auto overflow-x-hidden">
              {filteredEntries.map((entry) => (
                <React.Fragment key={entry.id}>
                  {renderEntry(entry)}
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

ConsoleTab.displayName = "ConsoleTab";

export default ConsoleTab;
