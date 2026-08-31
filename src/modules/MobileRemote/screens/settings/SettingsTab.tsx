import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { InlineBanner } from "@src/components/InlineBanner";

import { useMobileRemote } from "../../app";
import { MobileTopBar } from "../../components/MobileTopBar";
import { buildMobileWsUrl } from "../../connection/buildMobileWsUrl";
import type { MobileConnectionConfig } from "../../connection/types";

const STORAGE_KEY = "orgii-mobile-remote-config";

function loadStoredConfig(): MobileConnectionConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MobileConnectionConfig;
  } catch {
    return null;
  }
}

export function resolveRelayLabel(
  config: MobileConnectionConfig | null,
  demoMode: boolean
): string {
  if (demoMode) {
    return "demo";
  }
  if (!config) {
    return "";
  }
  try {
    if (config.wsUrl?.trim()) {
      return config.wsUrl.trim();
    }
    if (config.host?.trim()) {
      return buildMobileWsUrl(config);
    }
  } catch {
    return "";
  }
  return "";
}

function presenceLabel(
  presence: "online" | "offline" | "unknown",
  t: (key: string) => string
): string {
  switch (presence) {
    case "online":
      return t("settings.online");
    case "offline":
      return t("settings.offline");
    default:
      return t("settings.notAvailable");
  }
}

/** M-17 Settings — connection info and demo/live mode label. */
export function SettingsTab() {
  const { t } = useTranslation("mobileRemote");
  const { connection } = useMobileRemote();

  const relayLabel = useMemo(
    () => resolveRelayLabel(loadStoredConfig(), connection.demoMode),
    [connection.demoMode]
  );

  const desktopValue = connection.desktopName
    ? `${connection.desktopName} · ${presenceLabel(connection.presence, t)}`
    : t("settings.notAvailable");

  const modeLabel = connection.demoMode
    ? t("settings.modeDemo")
    : t("settings.modeLive");

  return (
    <>
      <MobileTopBar title={t("settings.title")} />
      {connection.demoMode ? (
        <InlineBanner tone="info">{t("settings.demoBanner")}</InlineBanner>
      ) : null}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 pt-4 text-xs font-medium uppercase tracking-wide text-text-3">
          {t("settings.connection")}
        </div>
        <SettingsRow label={t("settings.desktop")} value={desktopValue} />
        <SettingsRow
          label={t("settings.relay")}
          value={
            connection.demoMode
              ? t("settings.notAvailable")
              : relayLabel || t("settings.unknownRelay")
          }
        />
        <SettingsRow
          label={t("settings.permissionTier")}
          value={connection.tier ?? t("settings.notAvailable")}
        />
        <SettingsRow label={t("settings.mode")} value={modeLabel} />

        <div className="px-4 pt-6 text-xs font-medium uppercase tracking-wide text-text-3">
          {t("settings.help")}
        </div>
        <SettingsActionRow label={t("settings.pairingGuide")} />
        <SettingsActionRow
          label={t("settings.revokePairing")}
          trailing={t("settings.revoke")}
          trailingClassName="text-danger-6"
        />
      </div>
    </>
  );
}

SettingsTab.displayName = "SettingsTab";

interface SettingsRowProps {
  label: string;
  value: string;
}

function SettingsRow({ label, value }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between border-b border-border-2 px-4 py-3">
      <span className="text-sm text-text-1">{label}</span>
      <span className="max-w-[55%] truncate text-right text-[13px] text-text-3">
        {value}
      </span>
    </div>
  );
}

interface SettingsActionRowProps {
  label: string;
  trailing?: string;
  trailingClassName?: string;
}

function SettingsActionRow({
  label,
  trailing = "›",
  trailingClassName = "text-text-3",
}: SettingsActionRowProps) {
  return (
    <Button
      htmlType="button"
      variant="tertiary"
      appearance="ghost"
      className="h-auto w-full justify-between rounded-none border-b border-border-2 px-4 py-3 text-sm font-normal text-text-1"
    >
      <span>{label}</span>
      <span className={`text-[13px] ${trailingClassName}`}>{trailing}</span>
    </Button>
  );
}
