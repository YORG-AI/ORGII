/**
 * Download control surface for a cloud session replay.
 *
 * One mount point renders three states off two atoms:
 * - pending-play — a big session parked by the play gate: count + ETA and a
 *   Start button; nothing has transferred yet.
 * - downloading/finalizing — live progress with a Pause button. Pause keeps
 *   the persisted pages; nothing rolls back.
 * - paused — the held position with a Resume button.
 *
 * Two layout variants share the state machine: `centered` fills the Chat
 * Pane's loading state, `card` is the compact pinned strip used when a
 * transcript (skeleton or cached copy) is already rendering underneath.
 * Renders nothing when the session has neither a pending entry nor progress,
 * so both are safe to mount unconditionally.
 *
 * Start/Resume cannot call the replay hook from here — they park a start
 * request that the mounted sidebar section consumes.
 */
import { useSetAtom } from "jotai";
import type React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ProgressBar from "@src/components/ProgressBar";

import { cancelCloudSessionDownload } from "./cloudSessionDownloadAbortRegistry";
import {
  type CloudPendingPlay,
  cloudDownloadStartRequestAtom,
} from "./cloudSessionDownloadControlAtoms";
import {
  type CloudSessionDownloadProgress,
  cloudDownloadEtaMs,
  cloudDownloadPercent,
  formatCloudDownloadEta,
} from "./cloudSessionDownloadProgressAtom";
import {
  useCloudSessionDownloadProgressEntry,
  useCloudSessionPendingPlayEntry,
} from "./useCloudSessionDownloadSurface";

interface CloudSessionDownloadProgressCardProps {
  /** Local session id the surface renders (imported-session-* for replays). */
  sessionId: string | null | undefined;
  /** Layout: compact pinned `card` (default) or pane-filling `centered`. */
  variant?: "card" | "centered";
}

const DownloadBar: React.FC<{
  percent: number | null;
  paused?: boolean;
  className: string;
  compact?: boolean;
  ariaLabel?: string;
  ariaValuetext?: string;
}> = ({
  percent,
  paused = false,
  className,
  compact = false,
  ariaLabel,
  ariaValuetext,
}) => (
  <ProgressBar
    percent={percent ?? 0}
    indeterminate={percent === null}
    ariaLabel={ariaLabel}
    ariaValuetext={ariaValuetext}
    color={paused ? "bg-fill-4" : "bg-primary-6"}
    height={compact ? "h-0.5" : undefined}
    width={className}
    trackColor={compact ? "bg-transparent" : undefined}
    className={compact ? "rounded-none!" : undefined}
  />
);

/** Start/Resume both funnel through the sidebar-consumed request slot. */
function useRequestDownloadStart(): (params: {
  rowId: string;
  orgId: string;
  kind?: "replay" | "fork";
}) => void {
  const setStartRequest = useSetAtom(cloudDownloadStartRequestAtom);
  return ({ rowId, orgId, kind = "replay" }) =>
    setStartRequest({ requestId: Date.now(), rowId, orgId, kind });
}

const PendingPlay: React.FC<{
  pending: CloudPendingPlay;
  variant: "card" | "centered";
}> = ({ pending, variant }) => {
  const { t } = useTranslation("navigation");
  const requestStart = useRequestDownloadStart();
  const estimate = t("cloud.download.estimate", {
    count: pending.pendingEvents,
    eta: formatCloudDownloadEta(pending.etaMs),
  });
  const startButton = (
    <Button
      variant="secondary"
      size={variant === "centered" ? "small" : "mini"}
      data-testid="cloud-session-download-start"
      onClick={() =>
        requestStart({
          rowId: pending.rowId,
          orgId: pending.orgId,
          kind: pending.kind,
        })
      }
    >
      {pending.kind === "fork"
        ? t("cloud.orgPanel.fork")
        : t("cloud.download.start")}
    </Button>
  );
  if (variant === "centered") {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 p-6"
        data-testid="cloud-session-download-pending"
      >
        <div className="text-xs text-text-3 tabular-nums">{estimate}</div>
        {startButton}
      </div>
    );
  }
  return (
    <div
      className="pointer-events-auto mx-1 mb-2 flex items-center justify-between gap-2 rounded-md border border-border-2 bg-bg-2 p-3 text-xs text-text-2"
      data-testid="cloud-session-download-pending"
    >
      <span className="text-text-3 tabular-nums">{estimate}</span>
      {startButton}
    </div>
  );
};

const CenteredProgress: React.FC<{
  progress: CloudSessionDownloadProgress;
}> = ({ progress }) => {
  const { t } = useTranslation("navigation");
  const requestStart = useRequestDownloadStart();
  const percent = cloudDownloadPercent(progress);
  const etaMs = cloudDownloadEtaMs(progress);
  const finalizing = progress.phase === "finalizing";
  const paused = progress.phase === "paused";
  const completed = progress.phase === "completed";
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6"
      data-testid="cloud-session-download-progress"
    >
      <DownloadBar
        percent={percent}
        paused={paused}
        className="w-64 max-w-full"
      />
      <div className="flex items-center gap-2 text-xs text-text-3 tabular-nums">
        {finalizing ? (
          <span>{t("cloud.download.finalizing")}</span>
        ) : (
          <>
            {completed && <span>{t("cloud.download.complete")}</span>}
            {paused && <span>{t("cloud.download.paused")}</span>}
            {percent !== null && <span>{percent}%</span>}
            {progress.totalEvents !== null && (
              <span>
                {t("cloud.download.events", {
                  loaded: progress.loadedEvents,
                  total: progress.totalEvents,
                })}
              </span>
            )}
            {etaMs !== null && !paused && !completed && (
              <span>
                {t("cloud.download.eta", {
                  eta: formatCloudDownloadEta(etaMs),
                })}
              </span>
            )}
          </>
        )}
      </div>
      {!finalizing &&
        !completed &&
        (paused ? (
          <Button
            variant="secondary"
            size="small"
            data-testid="cloud-session-download-resume"
            onClick={() =>
              requestStart({ rowId: progress.rowId, orgId: progress.orgId })
            }
          >
            {t("cloud.download.resume")}
          </Button>
        ) : (
          <Button
            variant="tertiary"
            size="small"
            data-testid="cloud-session-download-pause"
            onClick={() => cancelCloudSessionDownload(progress.rowId)}
          >
            {t("cloud.download.pause")}
          </Button>
        ))}
    </div>
  );
};

const CardProgress: React.FC<{
  progress: CloudSessionDownloadProgress;
}> = ({ progress }) => {
  const { t } = useTranslation("navigation");
  const requestStart = useRequestDownloadStart();
  const percent = cloudDownloadPercent(progress);
  const etaMs = cloudDownloadEtaMs(progress);
  const finalizing = progress.phase === "finalizing";
  const paused = progress.phase === "paused";
  const completed = progress.phase === "completed";
  const statusLabel = finalizing
    ? t("cloud.download.finalizing")
    : completed
      ? t("cloud.download.complete")
      : paused
        ? t("cloud.download.paused")
        : t("cloud.download.title");
  const eventsLabel =
    progress.totalEvents !== null
      ? t("cloud.download.events", {
          loaded: progress.loadedEvents,
          total: progress.totalEvents,
        })
      : null;
  const etaLabel =
    etaMs !== null && !finalizing && !paused && !completed
      ? t("cloud.download.eta", { eta: formatCloudDownloadEta(etaMs) })
      : null;
  const progressValueText = [
    statusLabel,
    percent !== null ? `${percent}%` : null,
    eventsLabel,
    etaLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const showStatusInPill =
    finalizing || paused || completed || (!eventsLabel && percent === null);

  return (
    <div
      className="pointer-events-auto relative mb-2 flex items-center justify-center"
      data-testid="cloud-session-download-progress"
    >
      <DownloadBar
        percent={percent}
        paused={paused}
        className="absolute inset-x-0 -top-2"
        compact
        ariaLabel={statusLabel}
        ariaValuetext={progressValueText}
      />
      <div
        className="inline-flex max-w-[75%] min-w-0 shrink-0 items-center gap-2 rounded-full border border-border-2/80 bg-bg-2/95 px-3 py-1 text-[11px] text-text-3 shadow-lg backdrop-blur-md"
        data-testid="cloud-session-download-progress-pill"
      >
        {showStatusInPill && (
          <span className="shrink-0 text-text-2">{statusLabel}</span>
        )}
        {percent !== null && (
          <span className="shrink-0 font-medium text-text-2 tabular-nums">
            {percent}%
          </span>
        )}
        {eventsLabel && (
          <span className="min-w-0 truncate tabular-nums" title={eventsLabel}>
            {eventsLabel}
          </span>
        )}
        {etaLabel && <span className="shrink-0">{etaLabel}</span>}
        {!finalizing &&
          !completed &&
          (paused ? (
            <Button
              variant="secondary"
              size="mini"
              data-testid="cloud-session-download-resume"
              onClick={() =>
                requestStart({
                  rowId: progress.rowId,
                  orgId: progress.orgId,
                })
              }
            >
              {t("cloud.download.resume")}
            </Button>
          ) : (
            <Button
              variant="tertiary"
              size="mini"
              data-testid="cloud-session-download-pause"
              onClick={() => cancelCloudSessionDownload(progress.rowId)}
            >
              {t("cloud.download.pause")}
            </Button>
          ))}
      </div>
    </div>
  );
};

const CloudSessionDownloadProgressCard: React.FC<
  CloudSessionDownloadProgressCardProps
> = ({ sessionId, variant = "card" }) => {
  const progress = useCloudSessionDownloadProgressEntry(sessionId);
  const pending = useCloudSessionPendingPlayEntry(sessionId);
  // A live/paused transfer outranks a stale pending entry.
  if (progress) {
    return variant === "centered" ? (
      <CenteredProgress progress={progress} />
    ) : (
      <CardProgress progress={progress} />
    );
  }
  if (pending) {
    return <PendingPlay pending={pending} variant={variant} />;
  }
  return null;
};

export default CloudSessionDownloadProgressCard;
