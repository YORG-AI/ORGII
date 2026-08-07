import { Download } from "lucide-react";
import type { CSSProperties, FC } from "react";

import ProgressBar from "@src/components/ProgressBar";

import "./DownloadProgress.scss";

export interface AppUpdateDownloadProgress {
  active: boolean;
  collapsed: boolean;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export const EMPTY_APP_UPDATE_DOWNLOAD_PROGRESS: AppUpdateDownloadProgress = {
  active: false,
  collapsed: false,
  downloadedBytes: 0,
  totalBytes: null,
  percent: null,
};

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function getDownloadProgressTitle(
  progress: AppUpdateDownloadProgress
): string {
  return progress.percent === null
    ? "Downloading update…"
    : `Downloading update… ${progress.percent}%`;
}

function getDownloadProgressDetail(
  progress: AppUpdateDownloadProgress
): string {
  if (progress.totalBytes) {
    return `${formatBytes(progress.downloadedBytes)} of ${formatBytes(
      progress.totalBytes
    )}`;
  }
  if (progress.downloadedBytes > 0) {
    return `${formatBytes(progress.downloadedBytes)} downloaded`;
  }
  return "Preparing download…";
}

export const AppUpdateDownloadNoticeContent: FC<{
  progress: AppUpdateDownloadProgress;
}> = ({ progress }) => {
  const detail = getDownloadProgressDetail(progress);

  return (
    <div className="w-64 max-w-full pt-1">
      <div
        role="progressbar"
        aria-label="Update download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent ?? undefined}
        aria-valuetext={detail}
      >
        <ProgressBar
          percent={progress.percent ?? 0}
          height="h-1.5"
          className={
            progress.percent === null
              ? "app-update-download-progress--indeterminate"
              : undefined
          }
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs text-text-3">
        <span>{detail}</span>
        {progress.percent !== null && (
          <span className="shrink-0 tabular-nums">{progress.percent}%</span>
        )}
      </div>
    </div>
  );
};

interface DownloadProgressOrbProps {
  progress: AppUpdateDownloadProgress;
  onExpand: () => void;
}

type OrbStyle = CSSProperties & { "--download-progress": string };

export const DownloadProgressOrb: FC<DownloadProgressOrbProps> = ({
  progress,
  onExpand,
}) => {
  if (!progress.active || !progress.collapsed) return null;

  const liquidPercent = progress.percent ?? 28;
  const progressLabel =
    progress.percent === null ? "in progress" : `${progress.percent}%`;
  const style: OrbStyle = {
    "--download-progress": `${liquidPercent}%`,
  };

  return (
    <button
      type="button"
      className={`app-update-download-orb ${
        progress.percent === null
          ? "app-update-download-orb--indeterminate"
          : ""
      }`}
      style={style}
      aria-label={`Update download ${progressLabel}. Open progress notice.`}
      title="Open update download progress"
      onClick={onExpand}
    >
      <span className="app-update-download-orb__liquid" aria-hidden>
        <span className="app-update-download-orb__wave" />
      </span>
      <span className="app-update-download-orb__icon" aria-hidden>
        <Download size={18} strokeWidth={2.2} />
      </span>
    </button>
  );
};
