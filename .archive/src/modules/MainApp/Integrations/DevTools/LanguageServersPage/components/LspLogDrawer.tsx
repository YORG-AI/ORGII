/**
 * LspLogDrawer
 *
 * Renders the per-server stdio ring buffer fetched via
 * `lsp_get_server_log`. Surfaces what the server has been doing in
 * the last few seconds — outbound JSON-RPC requests, inbound
 * responses/notifications, and stderr lines — so users can diagnose
 * "rust-analyzer just stopped responding" / "pyright is panicking"
 * issues without needing `RUST_LOG=debug`.
 *
 * The Rust side caps the buffer at `MAX_LOG_LINES = 500` (see
 * `crates/lsp/src/log_buffer.rs`); long lines are truncated with a
 * `…(truncated, +Nb)` suffix.
 */
import { RefreshCw } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { useLspServerLog } from "../../../hooks/lsp";
import type { LspLogKind, LspLogLine } from "../types";

interface LspLogDrawerProps {
  language: string;
  /** Whether the drawer is currently visible / polling. */
  enabled: boolean;
}

const KIND_LABELS: Record<LspLogKind, string> = {
  std_in: "→",
  std_out: "←",
  std_err: "!",
};

const KIND_CLASSES: Record<LspLogKind, string> = {
  std_in: "text-info-6",
  std_out: "text-text-2",
  std_err: "text-danger-6",
};

function formatTimestamp(tsMs: number): string {
  const date = new Date(tsMs);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${millis}`;
}

export const LspLogDrawer: React.FC<LspLogDrawerProps> = ({
  language,
  enabled,
}) => {
  const { t } = useTranslation("integrations");
  const { log, isLoading, error, refresh } = useLspServerLog({
    language,
    enabled,
  });

  const reversed = useMemo<LspLogLine[]>(() => [...log].reverse(), [log]);

  const emptyTitle = t("lspPreview.logEmpty");

  return (
    <div className="rounded-lg bg-fill-2 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] text-text-2">
          {t("lspPreview.logCount", {
            count: log.length,
          })}
        </span>
        <Button
          size="small"
          icon={<RefreshCw size={12} />}
          loading={isLoading}
          onClick={refresh}
        >
          {t("common:actions.refresh")}
        </Button>
      </div>

      {error && (
        <div className="mb-2 rounded bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
          {error}
        </div>
      )}

      {reversed.length === 0 ? (
        <Placeholder variant="empty" title={emptyTitle} />
      ) : (
        <div className="max-h-[320px] overflow-auto rounded bg-bg-1">
          {reversed.map((entry, index) => (
            <div
              key={`${entry.tsMs}-${index}`}
              className="border-b border-border-1 px-3 py-1.5 last:border-b-0"
            >
              <div className="flex items-baseline gap-2 text-[11px]">
                <span className="text-text-3">
                  {formatTimestamp(entry.tsMs)}
                </span>
                <span className={KIND_CLASSES[entry.kind]}>
                  {KIND_LABELS[entry.kind]}
                </span>
                <span className="whitespace-pre-wrap break-all text-text-1">
                  {entry.line}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
