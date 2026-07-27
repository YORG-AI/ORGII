/**
 * DownloadProgressCard
 *
 * Reusable card for non-terminal download/install progress.
 * Designed to work inside GenericBottomPanel's Downloads tab,
 * but can be used standalone.
 */
import {
  Ban,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import React, { memo, useEffect, useState } from "react";

import Button from "@src/components/Button";
import { ProgressBar } from "@src/components/ProgressBar";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";

export type DownloadProgressStatus =
  | "pending"
  | "downloading"
  | "installing"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadProgressCardProps {
  name: string;
  status: DownloadProgressStatus;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  message?: string;
  onCancel?: () => void;
  onRetry?: () => void;
  startTime?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const STATUS_ICON: Record<DownloadProgressStatus, React.ReactNode> = {
  pending: <Download size={14} className="text-text-3" />,
  downloading: (
    <Loader2
      size={SPINNER_TOKENS.default}
      className="animate-spin text-primary-6"
    />
  ),
  installing: (
    <Loader2
      size={SPINNER_TOKENS.default}
      className="animate-spin text-warning-6"
    />
  ),
  completed: <CheckCircle2 size={14} className="text-success-6" />,
  failed: <XCircle size={14} className="text-danger-6" />,
  cancelled: <Ban size={14} className="text-text-3" />,
};

const STATUS_BAR_COLOR: Record<DownloadProgressStatus, string> = {
  pending: "bg-fill-3",
  downloading: "bg-primary-6",
  installing: "bg-warning-6",
  completed: "bg-success-6",
  failed: "bg-danger-6",
  cancelled: "bg-fill-3",
};

const STATUS_TEXT_COLOR: Record<DownloadProgressStatus, string> = {
  pending: "text-text-3",
  downloading: "text-primary-6",
  installing: "text-warning-6",
  completed: "text-success-6",
  failed: "text-danger-6",
  cancelled: "text-text-3",
};

const DownloadProgressCard: React.FC<DownloadProgressCardProps> = memo(
  ({
    name,
    status,
    progress,
    downloadedBytes,
    totalBytes,
    message,
    onCancel,
    onRetry,
    startTime,
  }) => {
    const isActive = status === "downloading" || status === "installing";
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
      if (!isActive || !startTime) return;

      const calcElapsed = () => Math.floor((Date.now() - startTime) / 1000);

      const interval = setInterval(() => {
        setElapsed(calcElapsed());
      }, 1000);

      const immediateTimeout = setTimeout(() => {
        setElapsed(calcElapsed());
      }, 0);

      return () => {
        clearInterval(interval);
        clearTimeout(immediateTimeout);
      };
    }, [isActive, startTime]);

    const bytesLabel =
      downloadedBytes !== undefined && totalBytes !== undefined
        ? `${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`
        : downloadedBytes !== undefined
          ? formatBytes(downloadedBytes)
          : null;

    return (
      <div className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-fill-3">
        {STATUS_ICON[status]}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[12px] font-medium text-text-1">
              {name}
            </span>
            {isActive && elapsed > 0 && (
              <span className="text-[11px] text-text-3">({elapsed}s)</span>
            )}
          </div>
          {(message || bytesLabel) && (
            <div className="flex items-center gap-2 text-[11px]">
              {message && (
                <span className={STATUS_TEXT_COLOR[status]}>{message}</span>
              )}
              {bytesLabel && <span className="text-text-3">{bytesLabel}</span>}
            </div>
          )}
        </div>

        <div className="w-24 shrink-0">
          <ProgressBar
            percent={progress}
            color={STATUS_BAR_COLOR[status]}
            width="w-full"
            animated={isActive}
          />
        </div>

        <span
          className={`w-10 text-right text-[11px] font-medium ${STATUS_TEXT_COLOR[status]}`}
        >
          {progress}%
        </span>

        {isActive && onCancel && (
          <Button
            size="mini"
            variant="tertiary"
            onClick={onCancel}
            className="ml-1 shrink-0"
          >
            <Ban size={12} />
          </Button>
        )}

        {status === "failed" && onRetry && (
          <Button
            size="mini"
            variant="tertiary"
            onClick={onRetry}
            className="ml-1 shrink-0"
          >
            <RefreshCw size={12} />
          </Button>
        )}
      </div>
    );
  }
);

DownloadProgressCard.displayName = "DownloadProgressCard";

export default DownloadProgressCard;
