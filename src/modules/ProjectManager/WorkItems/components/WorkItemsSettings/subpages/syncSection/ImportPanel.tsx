/**
 * ImportPanel — Phase 6 bulk historical import for adapters whose
 * `supports_import` flag is true (Linear, GitHub, Echo).
 *
 * The first time an import-capable adapter is attached, the Rust
 * worker queues a `import_progress` row in `pending` state and the
 * import cycle walks the remote's full history one page at a time.
 * Each page lands as `merge_external` rows in the outbox, the merge
 * cycle owns the actual local-write step, and this panel surfaces:
 *
 *   - **pending**   — explanatory copy, no actions yet.
 *   - **running**   — progress bar (or "N items imported" when the
 *                     adapter doesn't surface a total) + Cancel button.
 *   - **completed** — final summary, no actions.
 *   - **failed**    — last error + Retry button (cursor preserved).
 *   - **cancelled** — final summary, no actions.
 *
 * Subscribes to `subscribeSyncStatus` so the row visibly advances
 * without a manual refresh; the worker emits a `pull_cycle` event
 * after each persisted page.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AdapterDescriptor,
  type ImportProgressInfo,
  type ImportState,
  projectSyncApi,
  subscribeSyncStatus,
} from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import { Message } from "@src/components/Message";
import { SectionRow } from "@src/modules/shared/layouts/SectionLayout";

import { formatErrorMessage } from "./shared";

export interface ImportPanelProps {
  slug: string;
  adapter: AdapterDescriptor;
}

const ImportPanel: React.FC<ImportPanelProps> = ({ slug, adapter }) => {
  const { t } = useTranslation("projects");
  const [progress, setProgress] = useState<ImportProgressInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      try {
        const next = await projectSyncApi.importStatus(slug, adapter.id);
        setProgress(next);
      } catch (error) {
        if (!silent) {
          Message.error(
            t("settings.sync.import.errors.statusFailed", {
              error: formatErrorMessage(error),
            })
          );
        }
      } finally {
        setLoaded(true);
      }
    },
    [adapter.id, slug, t]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await projectSyncApi.importStatus(slug, adapter.id);
        if (!cancelled) setProgress(next);
      } catch {
        // Silent on mount: the panel falls back to the loading state
        // and the next worker event or manual action surfaces errors.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter.id, slug]);

  // Live-refresh on worker pull/merge events for this slug — the
  // import cycle emits a `pull_cycle` trigger after each page is
  // persisted, so the panel advances without manual polling.
  useEffect(() => {
    const unsubscribe = subscribeSyncStatus((event) => {
      if (event.project_slug !== slug) return;
      void refresh(true);
    });
    return unsubscribe;
  }, [refresh, slug]);

  const handleCancel = useCallback(async () => {
    setBusy("cancel");
    try {
      await projectSyncApi.importCancel(slug, adapter.id);
      await refresh();
    } catch (error) {
      Message.error(
        t("settings.sync.import.errors.cancelFailed", {
          error: formatErrorMessage(error),
        })
      );
    } finally {
      setBusy(null);
    }
  }, [adapter.id, refresh, slug, t]);

  const handleRetry = useCallback(async () => {
    setBusy("retry");
    try {
      await projectSyncApi.importRetry(slug, adapter.id);
      await refresh();
    } catch (error) {
      Message.error(
        t("settings.sync.import.errors.retryFailed", {
          error: formatErrorMessage(error),
        })
      );
    } finally {
      setBusy(null);
    }
  }, [adapter.id, refresh, slug, t]);

  if (!loaded) {
    return (
      <SectionRow
        label={t("settings.sync.import.title")}
        description={t("settings.sync.import.loading")}
        layout="vertical"
      >
        {null}
      </SectionRow>
    );
  }

  // No row at all → adapter doesn't support import, or the project
  // was attached before Phase 6 shipped. Render nothing — the parent
  // already gates on `supports_import`, but defending here means a
  // stale UI doesn't show an empty panel.
  if (!progress) {
    return null;
  }

  const description = describeState(progress.state, t);

  return (
    <SectionRow
      label={t("settings.sync.import.title")}
      description={description}
      layout="vertical"
    >
      <div className="flex flex-col gap-2">
        <ProgressLine progress={progress} />
        <ActionRow
          state={progress.state}
          busy={busy}
          onCancel={handleCancel}
          onRetry={handleRetry}
        />
        {progress.state === "failed" && progress.last_error && (
          <code className="rounded bg-fill-2 px-2 py-1 text-[12px] break-all text-danger-6">
            {progress.last_error}
          </code>
        )}
      </div>
    </SectionRow>
  );
};

interface ProgressLineProps {
  progress: ImportProgressInfo;
}

/**
 * Inline progress display. Three shapes:
 *
 *   - `pending` → state label only (worker hasn't started).
 *   - `running` with a `total_hint` → state label + "N / M items".
 *   - `running` without a hint → state label + "N items imported".
 *   - `completed` / `cancelled` / `failed` → final summary.
 */
const ProgressLine: React.FC<ProgressLineProps> = ({ progress }) => {
  const { t } = useTranslation("projects");
  const stateLabel = t(`settings.sync.import.stateLabel.${progress.state}`);

  if (progress.state === "completed") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold text-success-6">
          {stateLabel}
        </span>
        <span className="text-[12px] text-text-3">
          {t("settings.sync.import.completedSummary", {
            count: progress.imported_count,
          })}
        </span>
      </div>
    );
  }

  if (progress.state === "cancelled") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-semibold text-text-2">
          {stateLabel}
        </span>
        <span className="text-[12px] text-text-3">
          {t("settings.sync.import.cancelledSummary", {
            count: progress.imported_count,
          })}
        </span>
      </div>
    );
  }

  const countLine =
    progress.total_hint !== null
      ? t("settings.sync.import.progressWithTotal", {
          count: progress.imported_count,
          total: progress.total_hint,
        })
      : t("settings.sync.import.progressNoTotal", {
          count: progress.imported_count,
        });

  return (
    <div className="flex flex-col gap-1">
      <span
        className={`text-[13px] font-semibold ${
          progress.state === "failed" ? "text-danger-6" : "text-text-1"
        }`}
      >
        {stateLabel}
      </span>
      <span className="text-[12px] text-text-3">{countLine}</span>
      {progress.total_hint !== null && progress.state === "running" && (
        <ProgressBar
          numerator={progress.imported_count}
          denominator={progress.total_hint}
        />
      )}
    </div>
  );
};

interface ProgressBarProps {
  numerator: number;
  denominator: number;
}

/**
 * Lightweight inline progress bar — only rendered while `running`
 * and only when the adapter advertised a `total_hint`. Caps at 100%
 * to defend against a hint that turned out to be an undercount as
 * the import walked further pages.
 */
const ProgressBar: React.FC<ProgressBarProps> = ({
  numerator,
  denominator,
}) => {
  if (denominator <= 0) return null;
  const ratio = Math.min(1, Math.max(0, numerator / denominator));
  const percent = `${Math.round(ratio * 100)}%`;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-fill-2">
      <div
        className="h-full bg-primary-6 transition-[width] duration-300 ease-out"
        style={{ width: percent }}
      />
    </div>
  );
};

interface ActionRowProps {
  state: ImportState;
  busy: "cancel" | "retry" | null;
  onCancel: () => void;
  onRetry: () => void;
}

const ActionRow: React.FC<ActionRowProps> = ({
  state,
  busy,
  onCancel,
  onRetry,
}) => {
  const { t } = useTranslation("projects");
  if (state === "pending" || state === "running") {
    return (
      <div>
        <Button
          size="small"
          onClick={onCancel}
          loading={busy === "cancel"}
          disabled={busy !== null}
        >
          {t("settings.sync.import.cancel")}
        </Button>
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div>
        <Button
          variant="primary"
          size="small"
          onClick={onRetry}
          loading={busy === "retry"}
          disabled={busy !== null}
        >
          {t("settings.sync.import.retry")}
        </Button>
      </div>
    );
  }
  return null;
};

function describeState(state: ImportState, t: (key: string) => string): string {
  switch (state) {
    case "pending":
      return t("settings.sync.import.pendingDescription");
    case "running":
      return t("settings.sync.import.runningDescription");
    case "failed":
      return t("settings.sync.import.failedDescription");
    case "completed":
    case "cancelled":
      // Final-state rows describe themselves through the summary line
      // inside `ProgressLine`; the SectionRow description is empty so
      // the panel doesn't repeat itself.
      return "";
  }
}

export default ImportPanel;
