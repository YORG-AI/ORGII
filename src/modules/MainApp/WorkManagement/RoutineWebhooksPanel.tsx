/**
 * Webhook management for portable routines. Install/rotate return the
 * plaintext secret exactly once — shown until the row reloads, never
 * persisted on the frontend.
 */
import React, { useCallback, useEffect, useState } from "react";
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
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  HugeiconsIcon,
  Refresh04Icon,
} from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

const DELIVERY_STATUS_TONE: Record<string, string> = {
  accepted: "text-success-6",
  failed: "text-danger-6",
  rejected: "text-danger-6",
  ignored: "text-text-3",
  skipped: "text-text-3",
};

interface WebhookRowProps {
  routine: PortableRoutineSummary;
}

const WebhookRow: React.FC<WebhookRowProps> = ({ routine }) => {
  const { t } = useTranslation("sessions");
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<RoutineWebhookStatus | null>(null);
  const [installInfo, setInstallInfo] =
    useState<RoutineWebhookInstallInfo | null>(null);
  const [deliveries, setDeliveries] = useState<RoutineWebhookDelivery[] | null>(
    null
  );
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(() => {
    projectApi
      .routineWebhookStatus(routine.name)
      .then(setStatus)
      .catch((error: unknown) => {
        Message.error(error instanceof Error ? error.message : String(error));
      });
  }, [routine.name]);

  const loadDeliveries = useCallback(() => {
    projectApi
      .listRoutineWebhookDeliveries(routine.name, 50)
      .then(setDeliveries)
      .catch(() => setDeliveries([]));
  }, [routine.name]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (expanded && deliveries === null) loadDeliveries();
  }, [expanded, deliveries, loadDeliveries]);

  const runAction = useCallback(
    async (action: () => Promise<void>) => {
      setBusy(true);
      try {
        await action();
      } catch (error) {
        Message.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [setBusy]
  );

  const handleInstall = useCallback(
    () =>
      runAction(async () => {
        const info = await projectApi.installRoutineWebhook(routine.name);
        setInstallInfo(info);
        loadStatus();
      }),
    [loadStatus, routine.name, runAction]
  );

  const handleRotate = useCallback(
    () =>
      runAction(async () => {
        const info = await projectApi.rotateRoutineWebhook(routine.name);
        setInstallInfo(info);
        loadStatus();
      }),
    [loadStatus, routine.name, runAction]
  );

  const handleToggleEnabled = useCallback(
    () =>
      runAction(async () => {
        if (!status) return;
        const next = await projectApi.setRoutineWebhookEnabled(
          routine.name,
          !status.enabled
        );
        setStatus(next);
      }),
    [routine.name, runAction, status]
  );

  const handleReplay = useCallback(
    (deliveryId: string) =>
      runAction(async () => {
        await projectApi.replayRoutineWebhookDelivery(deliveryId);
        Message.success(
          t("webhooks.replayQueued", { defaultValue: "Delivery replayed" })
        );
        loadDeliveries();
      }),
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

  const Chevron = expanded ? ArrowDown01Icon : ArrowRight01Icon;
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

  return (
    <div className="border-b border-border-1">
      <button
        type="button"
        onClick={() => setExpanded((previous) => !previous)}
        data-testid={`routine-webhook-row-${routine.name}`}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-fill-1"
      >
        <HugeiconsIcon
          icon={Chevron}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-text-3"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-text-1">
            {routine.name}
            <span className="ml-1 text-[11px] text-text-3">
              rev {routine.revision}
            </span>
          </div>
          {status?.secretHint ? (
            <div className="truncate text-[11px] text-text-3">
              {t("webhooks.secretHint", { defaultValue: "Secret" })} ·{" "}
              {status.secretHint}
            </div>
          ) : null}
        </div>
        {statusChip}
      </button>
      {expanded && (
        <div className="flex flex-col gap-3 px-11 pb-3">
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
                  {status?.enabled
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
            <Button
              variant="tertiary"
              size="small"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={13}
                  strokeWidth={1.75}
                />
              }
              onClick={() => {
                loadStatus();
                loadDeliveries();
              }}
              data-testid={`routine-webhook-refresh-${routine.name}`}
            />
          </div>

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
                  icon={
                    <HugeiconsIcon
                      icon={Copy01Icon}
                      data-icon="copy"
                      size={12}
                    />
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
                  icon={
                    <HugeiconsIcon
                      icon={Copy01Icon}
                      data-icon="copy"
                      size={12}
                    />
                  }
                  onClick={() => handleCopy(installInfo.secret)}
                  data-testid={`routine-webhook-copy-secret-${routine.name}`}
                />
              </div>
            </div>
          ) : null}

          {deliveries === null ? (
            <div className="text-[12px] text-text-3">…</div>
          ) : deliveries.length === 0 ? (
            <div className="text-[12px] text-text-3">
              {t("webhooks.noDeliveries", {
                defaultValue: "No deliveries yet",
              })}
            </div>
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
      )}
    </div>
  );
};

const RoutineWebhooksPanel: React.FC = () => {
  const { t } = useTranslation("sessions");
  const [routines, setRoutines] = useState<PortableRoutineSummary[] | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="routine-webhooks-panel"
    >
      {error ? (
        <Placeholder variant="error" title={error} fillParentHeight />
      ) : routines === null ? (
        <Placeholder variant="loading" fillParentHeight />
      ) : routines.length === 0 ? (
        <Placeholder
          variant="empty"
          title={t("webhooks.empty", {
            defaultValue: "No routines yet — apply one from the CLI first",
          })}
          fillParentHeight
        />
      ) : (
        routines.map((routine) => (
          <WebhookRow key={routine.routineId} routine={routine} />
        ))
      )}
    </div>
  );
};

export default RoutineWebhooksPanel;
