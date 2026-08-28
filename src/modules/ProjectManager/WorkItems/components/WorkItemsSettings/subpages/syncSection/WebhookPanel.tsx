/**
 * WebhookPanel — Phase 5 inbound webhook configuration for adapters
 * whose `supports_webhook` flag is true (Linear, GitHub, Echo).
 *
 * Renders three states:
 *
 *   - **Not installed** — Install button mints a fresh secret and
 *     surfaces the install info modal once.
 *   - **Installed, no delivery** — shows the listener URL path + a
 *     Rotate button + a "waiting for first delivery" hint.
 *   - **Installed, recently delivered** — green dot indicator with
 *     the relative time since the last delivery (driver of the
 *     poll-skip freshness window).
 *
 * The panel never re-displays the secret after the install/rotate
 * modal closes — the Rust `webhookStatus` command is intentionally
 * write-only for secret material.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AdapterDescriptor,
  type WebhookInstallInfo,
  type WebhookStatusInfo,
  projectSyncApi,
} from "@src/api/http/project/sync";
import Button from "@src/components/Button";
import { Message } from "@src/components/Message";
import StatusDot from "@src/components/StatusDot";
import { Copy01Icon, HugeiconsIcon, Refresh04Icon } from "@src/icons";
import { SectionRow } from "@src/modules/shared/layouts/SectionLayout";
import { copyText } from "@src/util/data/clipboard";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { formatErrorMessage } from "./shared";

/** Phase 5 freshness window: 10 minutes (matches the Rust constant). */
const WEBHOOK_FRESHNESS_WINDOW_MS = 10 * 60 * 1000;

export interface WebhookPanelProps {
  /** Project slug — passed straight through to the API. */
  slug: string;
  /** Currently-selected adapter — only mounted when `supportsWebhook` is true. */
  adapter: AdapterDescriptor;
}

const WebhookPanel: React.FC<WebhookPanelProps> = ({ slug, adapter }) => {
  const { t } = useTranslation("projects");
  const [status, setStatus] = useState<WebhookStatusInfo | null>(null);
  const [installInfo, setInstallInfo] = useState<WebhookInstallInfo | null>(
    null
  );
  const [busy, setBusy] = useState<"install" | "rotate" | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await projectSyncApi.webhookStatus(slug, adapter.id);
      setStatus(next);
    } catch (error) {
      Message.error(
        t("settings.sync.webhook.errors.statusFailed", {
          error: formatErrorMessage(error),
        })
      );
    }
  }, [adapter.id, slug, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await projectSyncApi.webhookStatus(slug, adapter.id);
        if (!cancelled) setStatus(next);
      } catch {
        // Silent on mount — explicit user actions surface their own
        // errors below, and rendering the "loading" state is fine
        // until the next manual refresh.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter.id, slug]);

  const handleInstall = useCallback(async () => {
    setBusy("install");
    try {
      const info = await projectSyncApi.webhookInstall(slug, adapter.id);
      setInstallInfo(info);
      await refresh();
    } catch (error) {
      Message.error(
        t("settings.sync.webhook.errors.installFailed", {
          error: formatErrorMessage(error),
        })
      );
    } finally {
      setBusy(null);
    }
  }, [adapter.id, refresh, slug, t]);

  const handleRotate = useCallback(async () => {
    setBusy("rotate");
    try {
      const info = await projectSyncApi.webhookRotate(slug, adapter.id);
      setInstallInfo(info);
      await refresh();
    } catch (error) {
      Message.error(
        t("settings.sync.webhook.errors.rotateFailed", {
          error: formatErrorMessage(error),
        })
      );
    } finally {
      setBusy(null);
    }
  }, [adapter.id, refresh, slug, t]);

  const dismissInstallInfo = useCallback(() => {
    setInstallInfo(null);
  }, []);

  const copySecret = useCallback(async () => {
    if (!installInfo) return;
    try {
      await copyText(installInfo.secret_hex);
      Message.success(t("settings.sync.webhook.secretCopied"));
    } catch (error) {
      Message.error(
        t("settings.sync.webhook.errors.copyFailed", {
          error: formatErrorMessage(error),
        })
      );
    }
  }, [installInfo, t]);

  const copyUrlPath = useCallback(async () => {
    if (!status?.url_path) return;
    try {
      await copyText(status.url_path);
      Message.success(t("settings.sync.webhook.urlCopied"));
    } catch (error) {
      Message.error(
        t("settings.sync.webhook.errors.copyFailed", {
          error: formatErrorMessage(error),
        })
      );
    }
  }, [status?.url_path, t]);

  if (!status) {
    return (
      <SectionRow
        label={t("settings.sync.webhook.title")}
        description={t("settings.sync.webhook.loading")}
        layout="vertical"
      >
        {null}
      </SectionRow>
    );
  }

  const lastWebhookAt = status.last_webhook_at;
  const fresh =
    lastWebhookAt !== null &&
    Date.now() - lastWebhookAt < WEBHOOK_FRESHNESS_WINDOW_MS;

  if (!status.installed) {
    return (
      <SectionRow
        label={t("settings.sync.webhook.title")}
        description={t("settings.sync.webhook.notInstalledDescription")}
        layout="vertical"
      >
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="small"
            onClick={handleInstall}
            loading={busy === "install"}
            disabled={busy !== null}
          >
            {t("settings.sync.webhook.install")}
          </Button>
        </div>
        {installInfo && (
          <InstallInfoModal
            info={installInfo}
            onCopySecret={copySecret}
            onClose={dismissInstallInfo}
          />
        )}
      </SectionRow>
    );
  }

  return (
    <>
      <SectionRow
        label={t("settings.sync.webhook.title")}
        description={t("settings.sync.webhook.installedDescription")}
        layout="vertical"
      >
        <div className="flex flex-col gap-2">
          <StatusDot
            color={fresh ? "bg-success-6" : "bg-fill-4"}
            size="inline"
            labelClassName="text-[12px] text-text-3"
            ariaLabel={
              fresh
                ? t("settings.sync.webhook.indicatorFresh")
                : t("settings.sync.webhook.indicatorStale")
            }
            label={
              lastWebhookAt === null
                ? t("settings.sync.webhook.lastDeliveryNever")
                : t("settings.sync.webhook.lastDeliveryAgo", {
                    time: formatRelativeTime(lastWebhookAt, "long"),
                  })
            }
          />
          {status.url_path && (
            <div className="flex items-center gap-2">
              <code className="rounded bg-fill-2 px-2 py-1 text-[12px] text-text-2">
                {status.url_path}
              </code>
              <Button
                size="mini"
                icon={
                  <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />
                }
                onClick={copyUrlPath}
              >
                {t("settings.sync.webhook.copyUrl")}
              </Button>
            </div>
          )}
          <div>
            <Button
              size="small"
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={14}
                />
              }
              onClick={handleRotate}
              loading={busy === "rotate"}
              disabled={busy !== null}
            >
              {t("settings.sync.webhook.rotate")}
            </Button>
          </div>
        </div>
      </SectionRow>
      {installInfo && (
        <InstallInfoModal
          info={installInfo}
          onCopySecret={copySecret}
          onClose={dismissInstallInfo}
        />
      )}
    </>
  );
};

interface InstallInfoModalProps {
  info: WebhookInstallInfo;
  onCopySecret: () => void;
  onClose: () => void;
}

/**
 * Inline "fresh secret" panel rendered immediately after install or
 * rotate. The secret is shown exactly once — closing the panel
 * (or unmounting the parent) drops the value from React state and
 * the only remaining copy is whatever the user pasted into the
 * provider UI.
 */
const InstallInfoModal: React.FC<InstallInfoModalProps> = ({
  info,
  onCopySecret,
  onClose,
}) => {
  const { t } = useTranslation("projects");
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-warning-3 bg-warning-1 p-3">
      <div className="text-[13px] font-semibold text-warning-6">
        {t("settings.sync.webhook.secretTitle")}
      </div>
      <div className="text-[12px] text-text-2">
        {t("settings.sync.webhook.secretDescription")}
      </div>
      <code className="break-all rounded bg-fill-2 px-2 py-1 text-[12px] text-text-1">
        {info.secret_hex}
      </code>
      <div className="flex items-center gap-2">
        <Button
          size="mini"
          icon={<HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />}
          onClick={onCopySecret}
        >
          {t("settings.sync.webhook.copySecret")}
        </Button>
        <Button variant="primary" size="mini" onClick={onClose}>
          {t("settings.sync.webhook.dismissSecret")}
        </Button>
      </div>
    </div>
  );
};

export default WebhookPanel;
