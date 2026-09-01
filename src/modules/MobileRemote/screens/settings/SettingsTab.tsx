import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { InlineBanner } from "@src/components/InlineBanner";
import { ArrowRight02Icon, HugeiconsIcon, Unlink02Icon } from "@src/icons";
import {
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { useMobileRemote } from "../../app";
import { MobileTopBar } from "../../components/MobileTopBar";
import { buildMobileWsUrl } from "../../connection/buildMobileWsUrl";
import type {
  MobileConnectionConfig,
  MobilePermissionTier,
} from "../../connection/types";

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

export function resolvePermissionTierLabel(
  tier: MobilePermissionTier | undefined,
  t: (key: string) => string
): string {
  switch (tier) {
    case "full":
      return t("settings.permissionFull");
    case "read_only":
      return t("settings.permissionReadOnly");
    default:
      return t("settings.notAvailable");
  }
}

export interface SettingsTabProps {
  onOpenPairingGuide?: () => void;
  onRevokePairing?: () => void;
}

/** M-17 Settings — connection info and demo/live mode label. */
export function SettingsTab({
  onOpenPairingGuide,
  onRevokePairing,
}: SettingsTabProps) {
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
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-5">
          <SectionContainer
            title={t("settings.connection")}
            dataTestId="mobile-remote-connection-settings"
          >
            <SettingsValueRow
              label={t("settings.desktop")}
              value={desktopValue}
            />
            <SettingsValueRow
              label={t("settings.relay")}
              value={
                connection.demoMode
                  ? t("settings.notAvailable")
                  : relayLabel || t("settings.unknownRelay")
              }
            />
            <SettingsValueRow
              label={t("settings.permissionTier")}
              value={resolvePermissionTierLabel(connection.tier, t)}
            />
            <SettingsValueRow label={t("settings.mode")} value={modeLabel} />
          </SectionContainer>

          {onOpenPairingGuide || onRevokePairing ? (
            <SectionContainer
              title={t("settings.help")}
              dataTestId="mobile-remote-help-settings"
            >
              {onOpenPairingGuide ? (
                <SettingsActionRow
                  label={t("settings.pairingGuide")}
                  onClick={onOpenPairingGuide}
                />
              ) : null}
              {onRevokePairing ? (
                <SettingsActionRow
                  label={t("settings.revokePairing")}
                  danger
                  onClick={onRevokePairing}
                />
              ) : null}
            </SectionContainer>
          ) : null}
        </div>
      </div>
    </>
  );
}

SettingsTab.displayName = "SettingsTab";

interface SettingsRowProps {
  label: string;
  value: string;
}

function SettingsValueRow({ label, value }: SettingsRowProps) {
  return (
    <SectionRow label={label} layout="inline">
      <span
        className={`block min-w-0 max-w-full truncate text-right ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
        title={value}
      >
        {value}
      </span>
    </SectionRow>
  );
}

interface SettingsActionRowProps {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function SettingsActionRow({
  label,
  danger = false,
  onClick,
}: SettingsActionRowProps) {
  return (
    <SectionRow showHeader={false} className="!min-h-0 !py-1.5">
      <Button
        htmlType="button"
        variant={danger ? "danger" : "tertiary"}
        appearance="ghost"
        size="small"
        long
        icon={
          <HugeiconsIcon
            icon={danger ? Unlink02Icon : ArrowRight02Icon}
            size={16}
          />
        }
        iconPosition="right"
        className="justify-between !px-0 font-normal"
        onClick={onClick}
      >
        {label}
      </Button>
    </SectionRow>
  );
}
