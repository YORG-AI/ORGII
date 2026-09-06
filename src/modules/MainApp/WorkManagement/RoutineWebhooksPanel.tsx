/**
 * Webhook management for portable routines. Install/rotate return the
 * plaintext secret exactly once — shown until the detail reloads, never
 * persisted on the frontend.
 */
import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type PortableRoutineSummary,
  type RoutineWebhookDelivery,
  type RoutineWebhookInstallInfo,
  type RoutineWebhookStatus,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import { Copy01Icon, HugeiconsIcon, Link01Icon } from "@src/icons";
import CompactListPanel, {
  type CompactListPanelEntry,
} from "@src/modules/shared/components/CompactListPanel";
import { WorkManagementRefreshButton } from "@src/modules/shared/components/WorkManagementRefreshButton";
import DetailPaneLayout, {
  DetailPanePlaceholder,
} from "@src/modules/shared/layouts/DetailPaneLayout";
import InboxListDetailLayout from "@src/modules/shared/layouts/InboxListDetailLayout";
import { copyText } from "@src/util/data/clipboard";

const DELIVERY_STATUS_TONE: Record<string, string> = {
  accepted: "text-success-6",
  failed: "text-danger-6",
  rejected: "text-danger-6",
  ignored: "text-text-3",
  skipped: "text-text-3",
};

export function searchPortableRoutines(
  routines: readonly PortableRoutineSummary[],
  query: string
): PortableRoutineSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...routines];

  return routines.filter((routine) =>
    [routine.name, routine.routineId, routine.specHash].some((value) =>
      value.toLocaleLowerCase().includes(normalizedQuery)
    )
  );
}

interface WebhookDetailPaneProps {
  routine: PortableRoutineSummary | null;
  onClose: () => void;
}

const WebhookDetailPane: React.FC<WebhookDetailPaneProps> = ({
  routine,
  onClose,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const [status, setStatus] = useState<RoutineWebhookStatus | null>(null);
  const [installInfo, setInstallInfo] =
    useState<RoutineWebhookInstallInfo | null>(null);
  const [deliveries, setDeliveries] = useState<RoutineWebhookDelivery[] | null>(
    null
  );
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    if (!routine) return;
    projectApi
      .routineWebhookStatus(routine.name)
      .then(setStatus)
      .catch((error: unknown) => {
        Message.error(error instanceof Error ? error.message : String(error));
      });
  }, [routine]);

  const loadDeliveries = useCallback(() => {
    if (!routine) return;
    projectApi
      .listRoutineWebhookDeliveries(routine.name, 50)
      .then(setDeliveries)
      .catch(() => setDeliveries([]));
  }, [routine]);

  useEffect(() => {
    loadStatus();
    loadDeliveries();
  }, [loadDeliveries, loadStatus]);

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const handleInstall = useCallback(() => {
    if (!routine) return;
    void runAction(async () => {
      const info = await projectApi.installRoutineWebhook(routine.name);
      setInstallInfo(info);
      loadStatus();
    });
  }, [loadStatus, routine, runAction]);

  const handleRotate = useCallback(() => {
    if (!routine) return;
    void runAction(async () => {
      const info = await projectApi.rotateRoutineWebhook(routine.name);
      setInstallInfo(info);
      loadStatus();
    });
  }, [loadStatus, routine, runAction]);

  const handleToggleEnabled = useCallback(() => {
    if (!routine) return;
    void runAction(async () => {
      if (!status) return;
      const next = await projectApi.setRoutineWebhookEnabled(
        routine.name,
        !status.enabled
      );
      setStatus(next);
    });
  }, [routine, runAction, status]);

  const handleReplay = useCallback(
    (deliveryId: string) => {
      void runAction(async () => {
        await projectApi.replayRoutineWebhookDelivery(deliveryId);
        Message.success(
          t("webhooks.replayQueued", { defaultValue: "Delivery replayed" })
        );
        loadDeliveries();
      });
    },
    [loadDeliveries, runAction, t]
  );

  const handleCopy = useCallback(
    async (value: string) => {
      try {
        await copyText(value);
        Message.success(t("webhooks.copied", { defaultValue: "Copied" }));
      } catch {
        Message.error(
          t("webhooks.copyFailed", { defaultValue: "Copy failed" })
        );
      }
    },
    [t]
  );

  if (!routine) {
    return (
      <DetailPaneLayout testId="routine-webhook-detail-pane">
        <DetailPanePlaceholder
          variant="empty"
          title={t("common:teamInbox.empty.selectTitle")}
          subtitle={t("common:teamInbox.empty.selectSubtitle")}
        />
      </DetailPaneLayout>
    );
  }

  const paused = Boolean(status?.pausedAt);
  const statusChip = !status ? null : !status.installed ? (
    <span className="text-[11px] text-text-4">
      {t("webhooks.notInstalled", { defaultValue: "Not installed" })}
    </span>
  ) : paused ? (
    <span className="text-[11px] font-medium text-danger-6">
      {t("webhooks.paused", {
        defaultValue: "Paused after {{count}} failures",
        count: status.consecutiveFailures,
      })}
    </span>
  ) : status.enabled ? (
    <span className="text-[11px] font-medium text-success-6">
      {t("webhooks.enabled", { defaultValue: "Enabled" })}
    </span>
  ) : (
    <span className="text-[11px] text-text-3">
      {t("webhooks.disabled", { defaultValue: "Disabled" })}
    </span>
  );
  const copyLabel = t("webhooks.copy", { defaultValue: "Copy" });

  return (
    <DetailPaneLayout
      testId="routine-webhook-detail-pane"
      header={{
        title: routine.name,
        subtitle: `rev ${routine.revision}`,
        icon: Link01Icon,
        actions: statusChip,
      }}
      onClose={onClose}
      closeTestId="routine-webhook-detail-close"
    >
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
        data-testid={`routine-webhook-detail-${routine.name}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {status?.installed ? (
            <>
              <Button
                variant="secondary"
                size="small"
                onClick={handleToggleEnabled}
                disabled={busy || !status}
                data-testid={`routine-webhook-toggle-${routine.name}`}
              >
                {status.enabled
                  ? t("webhooks.disable", { defaultValue: "Disable" })
                  : t("webhooks.enable", { defaultValue: "Enable" })}
              </Button>
              <Button
                variant="tertiary"
                size="small"
                onClick={handleRotate}
                disabled={busy}
                data-testid={`routine-webhook-rotate-${routine.name}`}
              >
                {t("webhooks.rotate", { defaultValue: "Rotate secret" })}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="small"
              onClick={handleInstall}
              disabled={busy}
              data-testid={`routine-webhook-install-${routine.name}`}
            >
              {t("webhooks.install", { defaultValue: "Install webhook" })}
            </Button>
          )}
          <WorkManagementRefreshButton
            label={t("common:actions.refresh", { defaultValue: "Refresh" })}
            loading={busy}
            onRefresh={() => {
              loadStatus();
              loadDeliveries();
            }}
            dataTestId={`routine-webhook-refresh-${routine.name}`}
          />
        </div>

        {status?.secretHint ? (
          <div className="text-[11px] text-text-3">
            {t("webhooks.secretHint", { defaultValue: "Secret" })} ·{" "}
            {status.secretHint}
          </div>
        ) : null}

        {installInfo ? (
          <div
            className="flex flex-col gap-1.5 rounded-md bg-fill-1 px-3 py-2.5"
            data-testid={`routine-webhook-install-info-${routine.name}`}
          >
            <p className="text-[11px] text-text-3">
              {t("webhooks.secretShownOnce", {
                defaultValue:
                  "The secret is shown once — store it in your provider now.",
              })}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-[11px] text-text-2">
                {installInfo.urlPath}
              </code>
              <Button
                variant="tertiary"
                size="mini"
                iconOnly
                aria-label={copyLabel}
                icon={
                  <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />
                }
                onClick={() => handleCopy(installInfo.urlPath)}
                data-testid={`routine-webhook-copy-url-${routine.name}`}
              />
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-[11px] text-text-2">
                {installInfo.secret}
              </code>
              <Button
                variant="tertiary"
                size="mini"
                iconOnly
                aria-label={copyLabel}
                icon={
                  <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />
                }
                onClick={() => handleCopy(installInfo.secret)}
                data-testid={`routine-webhook-copy-secret-${routine.name}`}
              />
            </div>
          </div>
        ) : null}

        {deliveries === null ? (
          <Placeholder variant="loading" />
        ) : deliveries.length === 0 ? (
          <Placeholder
            variant="empty"
            title={t("webhooks.noDeliveries", {
              defaultValue: "No deliveries yet",
            })}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {deliveries.map((delivery) => (
              <li
                key={delivery.id}
                className="flex items-center gap-2 rounded px-1 py-1 text-[12px]"
                data-testid={`routine-webhook-delivery-${delivery.id}`}
              >
                <span
                  className={`shrink-0 font-medium ${
                    DELIVERY_STATUS_TONE[delivery.status] ?? "text-text-2"
                  }`}
                >
                  {delivery.status}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-2">
                  {delivery.provider}/{delivery.eventKind}
                  {delivery.reason ? ` · ${delivery.reason}` : ""}
                </span>
                <span className="shrink-0 text-[11px] text-text-3">
                  {new Date(delivery.createdAt).toLocaleString()}
                </span>
                <Button
                  variant="tertiary"
                  size="mini"
                  onClick={() => handleReplay(delivery.id)}
                  disabled={busy}
                  data-testid={`routine-webhook-replay-${delivery.id}`}
                >
                  {t("webhooks.replay", { defaultValue: "Replay" })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DetailPaneLayout>
  );
};

interface RoutineWebhooksPanelProps {
  query?: string;
  listHeader?: ReactNode;
  fullHeader?: ReactNode;
  listFullscreen?: boolean;
  onSelectDetail?: () => void;
}

const RoutineWebhooksPanel: React.FC<RoutineWebhooksPanelProps> = ({
  query = "",
  listHeader,
  fullHeader,
  listFullscreen = false,
  onSelectDetail,
}) => {
  const { t } = useTranslation("sessions");
  const [routines, setRoutines] = useState<PortableRoutineSummary[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(
    null
  );

  const load = useCallback(() => {
    projectApi
      .listPortableRoutines()
      .then((rows) => {
        setRoutines(rows);
        setError(null);
      })
      .catch((loadError: unknown) => {
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const visibleRoutines = useMemo(
    () => (routines ? searchPortableRoutines(routines, query) : []),
    [query, routines]
  );
  const selectedRoutine =
    visibleRoutines.find(
      (routine) => routine.routineId === selectedRoutineId
    ) ?? null;
  const entries = useMemo<CompactListPanelEntry[]>(
    () =>
      visibleRoutines.map((routine) => ({
        key: routine.routineId,
        title: routine.name,
        titlePrefix: `rev ${routine.revision}`,
        time: new Date(routine.updatedAt).toLocaleString(),
        metadata: <span className="truncate">{routine.routineId}</span>,
        preview: routine.specHash,
        leading: (
          <HugeiconsIcon
            icon={Link01Icon}
            data-icon="link"
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ),
        leadingClassName: routine.enabled ? "text-success-6" : "text-text-3",
        ariaLabel: `${routine.name}, rev ${routine.revision}`,
        dataAttributes: {
          "data-testid": "routine-webhook-row",
          "data-routine-id": routine.routineId,
        },
        onSelect: () => {
          setSelectedRoutineId(routine.routineId);
          onSelectDetail?.();
        },
      })),
    [onSelectDetail, visibleRoutines]
  );

  const emptyContent = error ? (
    <Placeholder
      variant="error"
      placement="sidebar"
      title={error}
      fillParentHeight
    />
  ) : routines && routines.length === 0 ? (
    <Placeholder
      variant="empty"
      placement="sidebar"
      title={t("webhooks.empty", {
        defaultValue: "No routines yet — apply one from the CLI first",
      })}
      fillParentHeight
    />
  ) : (
    <Placeholder variant="no-results" placement="sidebar" fillParentHeight />
  );
  const routineList = (
    <CompactListPanel
      ariaLabel={t("webhooks.title", { defaultValue: "Webhooks" })}
      entries={entries}
      selectedEntryKey={selectedRoutine?.routineId ?? null}
      loading={routines === null && !error}
      emptyContent={emptyContent}
      testId="routine-webhooks-compact-list"
    />
  );

  return (
    <InboxListDetailLayout
      testId="routine-webhooks-list-detail-layout"
      defaultSplit
      listFullscreen={listFullscreen}
      listHeader={listHeader}
      fullHeader={fullHeader}
      listContent={routineList}
      fullContent={routineList}
      detailContent={
        <WebhookDetailPane
          key={selectedRoutine?.routineId ?? "empty"}
          routine={selectedRoutine}
          onClose={() => setSelectedRoutineId(null)}
        />
      }
    />
  );
};

export default RoutineWebhooksPanel;
