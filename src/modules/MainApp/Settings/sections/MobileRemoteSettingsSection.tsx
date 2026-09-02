import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type {
  PairedDeviceInfo,
  PairingInitOutput,
  RelayStatus,
} from "@src/api/tauri/mobileRemote";
import mobileRemoteApi, { PERMISSION_TIER } from "@src/api/tauri/mobileRemote";
import Button from "@src/components/Button";
import { InlineBanner } from "@src/components/InlineBanner";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { useAsyncData } from "@src/hooks/async";
import { useSetting } from "@src/hooks/settings/useSettings";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import MobileRemoteOutdoorPairingDetails from "./MobileRemoteOutdoorPairingDetails";
import MobileRemoteQrCodeDisplay from "./MobileRemoteQrCodeDisplay";
import {
  buildMobileRemoteWsUrl,
  fetchMobileRemoteLanIp,
  generateMobileRemoteLanToken,
  isMobileRemoteLanHostPlaceholder,
  resolveMobileRemoteLanHostWithIp,
} from "./mobileRemoteSettingsHelpers";

function formatDeviceTimestamp(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  return formatRelativeTime(ms, "short");
}

const MobileRemoteSettingsSection: React.FC = () => {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useSetting("mobileRemote.enabled");
  const [relayEnabled, setRelayEnabled] = useSetting(
    "mobileRemote.relayEnabled"
  );
  const [relayUrl, setRelayUrl] = useSetting("mobileRemote.relayUrl");
  const [desktopToken, setDesktopToken] = useSetting(
    "mobileRemote.desktopToken"
  );
  const [allowLanExposure, setAllowLanExposure] = useSetting(
    "mobileRemote.allowLanExposure"
  );
  const [lanToken, setLanToken] = useSetting("mobileRemote.lanToken");
  const [lanPort] = useSetting("mobileRemote.lanPort");

  const [phoneLabel, setPhoneLabel] = useState("My phone");
  const [fullAccess, setFullAccess] = useState(true);
  const [pairing, setPairing] = useState<PairingInitOutput | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingConfirming, setPairingConfirming] = useState(false);
  const pairingRequestIdRef = useRef(0);

  const handleEnabledChange = useCallback(
    (next: boolean) => {
      setEnabled(next);
      if (next && lanToken.trim().length === 0) {
        setLanToken(generateMobileRemoteLanToken());
      }
    },
    [lanToken, setEnabled, setLanToken]
  );

  const relayConfigured =
    relayEnabled &&
    /^wss?:\/\//.test(relayUrl.trim()) &&
    desktopToken.trim().length >= 24;
  const relayQueryKey = `${enabled}:${relayEnabled}:${relayUrl}:${desktopToken.length}`;
  const {
    data: relayStatus,
    loading: relayStatusLoading,
    refresh: refreshRelayStatus,
  } = useAsyncData<RelayStatus | null, string>({
    key: relayQueryKey,
    initialData: null,
    enabled,
    query: async () => mobileRemoteApi.getRelayStatus(),
  });

  const handleStartPairing = useCallback(async () => {
    const requestId = ++pairingRequestIdRef.current;
    setPairingLoading(true);
    try {
      const next = await mobileRemoteApi.pairInit({
        tier: fullAccess ? PERMISSION_TIER.FULL : PERMISSION_TIER.READ_ONLY,
        label: phoneLabel.trim() || "My phone",
        isPrimary: true,
      });
      if (requestId !== pairingRequestIdRef.current) return;
      setPairing(next);
    } catch (error) {
      if (requestId !== pairingRequestIdRef.current) return;
      Message.error({
        content: `${t("mobileRemote.pairingFailed")}: ${String(error)}`,
      });
    } finally {
      if (requestId === pairingRequestIdRef.current) {
        setPairingLoading(false);
      }
    }
  }, [fullAccess, phoneLabel, t]);

  useEffect(() => {
    pairingRequestIdRef.current += 1;
    setPairing(null);
    setPairingLoading(false);
  }, [desktopToken, enabled, relayEnabled, relayUrl]);

  useEffect(
    () => () => {
      pairingRequestIdRef.current += 1;
    },
    []
  );

  const {
    data: devices,
    loading: devicesLoading,
    error: devicesError,
    refresh: refreshDevices,
  } = useAsyncData<PairedDeviceInfo[], string>({
    key: relayQueryKey,
    initialData: [],
    enabled: enabled && relayConfigured,
    query: async () => mobileRemoteApi.syncDevices(),
  });

  const handleConfirmPairing = useCallback(async () => {
    if (!pairing) return;
    setPairingConfirming(true);
    try {
      await mobileRemoteApi.pairComplete({
        pairingCode: pairing.pairingCode,
        tier: fullAccess ? PERMISSION_TIER.FULL : PERMISSION_TIER.READ_ONLY,
      });
      setPairing(null);
      Message.success({ content: t("mobileRemote.pairingConfirmed") });
      refreshDevices();
    } catch (error) {
      Message.error({ content: String(error) });
    } finally {
      setPairingConfirming(false);
    }
  }, [fullAccess, pairing, refreshDevices, t]);

  const handleRevokeDevice = useCallback(
    async (deviceId: string) => {
      try {
        await mobileRemoteApi.revokeDevice(deviceId);
        refreshDevices();
      } catch (error) {
        Message.error({ content: String(error) });
      }
    },
    [refreshDevices]
  );

  const {
    data: resolvedLanIp,
    loading: lanIpLoading,
    refresh: refreshLanIp,
  } = useAsyncData<string | null, boolean>({
    key: enabled && allowLanExposure,
    initialData: null,
    enabled: enabled && allowLanExposure,
    query: async () => fetchMobileRemoteLanIp(),
  });
  const wsHost = useMemo(
    () => resolveMobileRemoteLanHostWithIp(allowLanExposure, resolvedLanIp),
    [allowLanExposure, resolvedLanIp]
  );
  const lanWsUrl = useMemo(
    () =>
      buildMobileRemoteWsUrl({ host: wsHost, port: lanPort, token: lanToken }),
    [lanPort, lanToken, wsHost]
  );

  return (
    <SectionContainer>
      <SectionRow
        label={t("mobileRemote.enabled")}
        description={t("mobileRemote.enabledDesc")}
      >
        <Switch checked={enabled} onCheckedChange={handleEnabledChange} />
      </SectionRow>

      {enabled ? (
        <>
          <InlineBanner tone="info">
            {t("mobileRemote.relaySetupNotice")}
          </InlineBanner>

          <SectionRow
            label={t("mobileRemote.outdoorTitle")}
            description={t("mobileRemote.outdoorDesc")}
            indent
          >
            <Switch checked={relayEnabled} onCheckedChange={setRelayEnabled} />
          </SectionRow>

          {relayEnabled ? (
            <>
              <SectionRow
                label={t("mobileRemote.relayUrl")}
                description={t("mobileRemote.relayUrlDesc")}
                layout="vertical"
                indent
              >
                <Input
                  value={relayUrl}
                  onChange={setRelayUrl}
                  placeholder="wss://relay.example.com/v1/mobile/ws"
                  spellCheck={false}
                />
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.desktopToken")}
                description={t("mobileRemote.desktopTokenDesc")}
                layout="vertical"
                indent
              >
                <Input
                  type="password"
                  value={desktopToken}
                  onChange={setDesktopToken}
                  spellCheck={false}
                  autoComplete="off"
                />
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.relayStatus")}
                description={
                  relayStatus?.message ?? t("mobileRemote.relayEnabledDesc")
                }
                indent
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text-2">
                    {relayStatusLoading
                      ? t("mobileRemote.relayStatus_connecting")
                      : t(
                          `mobileRemote.relayStatus_${relayStatus?.phase ?? "stopped"}`
                        )}
                  </span>
                  <Button
                    variant="tertiary"
                    appearance="ghost"
                    size="small"
                    onClick={refreshRelayStatus}
                  >
                    {t("common:actions.refresh")}
                  </Button>
                </div>
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.phoneLabel")}
                description={t("mobileRemote.phoneLabelDesc")}
                layout="vertical"
                indent
              >
                <Input
                  value={phoneLabel}
                  onChange={setPhoneLabel}
                  maxLength={80}
                />
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.fullAccess")}
                description={t("mobileRemote.fullAccessDesc")}
                indent
              >
                <Switch checked={fullAccess} onCheckedChange={setFullAccess} />
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.pairing")}
                description={t("mobileRemote.sasDesktopHint")}
                layout="vertical"
                indent
              >
                {!pairing ? (
                  <Button
                    variant="primary"
                    loading={pairingLoading}
                    disabled={!relayConfigured || pairingLoading}
                    onClick={() => void handleStartPairing()}
                  >
                    {t("mobileRemote.startOutdoorPairing")}
                  </Button>
                ) : (
                  <MobileRemoteOutdoorPairingDetails
                    pairing={pairing}
                    confirming={pairingConfirming}
                    regenerating={pairingLoading}
                    onConfirm={() => void handleConfirmPairing()}
                    onRegenerate={() => void handleStartPairing()}
                  />
                )}
              </SectionRow>

              <SectionRow
                label={t("mobileRemote.pairedDevices")}
                description={t("mobileRemote.pairedDevicesDesc")}
                layout="vertical"
                indent
              >
                {devicesLoading ? (
                  <Placeholder variant="loading" placement="sidebar" />
                ) : devicesError ? (
                  <Placeholder
                    variant="error"
                    placement="sidebar"
                    title={t("mobileRemote.devicesLoadFailed")}
                    subtitle={devicesError}
                    onRetry={refreshDevices}
                  />
                ) : devices.length === 0 ? (
                  <Placeholder
                    variant="empty"
                    placement="sidebar"
                    title={t("mobileRemote.noDevices")}
                    subtitle={t("mobileRemote.noDevicesDesc")}
                  />
                ) : (
                  <SettingsTable<PairedDeviceInfo>
                    columns={[
                      {
                        key: "label",
                        label: t("mobileRemote.deviceLabel"),
                        width: SETTINGS_TABLE_COL.fill,
                        renderCell: (row) => (
                          <span className={SETTINGS_TABLE_CELL.primary}>
                            {row.label || row.deviceId}
                          </span>
                        ),
                      },
                      {
                        key: "tier",
                        label: t("mobileRemote.deviceTier"),
                        width: SETTINGS_TABLE_COL.valueSm,
                        renderCell: (row) => (
                          <span className={SETTINGS_TABLE_CELL.muted}>
                            {row.tier}
                          </span>
                        ),
                      },
                      {
                        key: "lastSeenMs",
                        label: t("mobileRemote.deviceLastSeen"),
                        width: SETTINGS_TABLE_COL.valueMd,
                        align: "right",
                        renderCell: (row) => (
                          <span className={SETTINGS_TABLE_CELL.value}>
                            {formatDeviceTimestamp(row.lastSeenMs)}
                          </span>
                        ),
                      },
                      {
                        key: "actions",
                        label: "",
                        width: SETTINGS_TABLE_COL.hug,
                        renderCell: (row) => (
                          <Button
                            variant="danger"
                            appearance="ghost"
                            size="small"
                            onClick={() =>
                              void handleRevokeDevice(row.deviceId)
                            }
                          >
                            {t("mobileRemote.revokeDevice")}
                          </Button>
                        ),
                      },
                    ]}
                    rows={devices}
                    getRowKey={(row) => row.deviceId}
                  />
                )}
              </SectionRow>
            </>
          ) : null}

          <SectionRow
            label={t("mobileRemote.lanAdvanced")}
            description={t("mobileRemote.lanAdvancedDesc")}
            indent
          >
            <Switch
              checked={allowLanExposure}
              onCheckedChange={setAllowLanExposure}
            />
          </SectionRow>

          {allowLanExposure ? (
            <SectionRow
              label={t("mobileRemote.pairing")}
              description={t("mobileRemote.pairingDesc")}
              layout="vertical"
              indent
            >
              <InlineBanner tone="warning">
                {t("mobileRemote.securityNotice")}
              </InlineBanner>
              <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start">
                <MobileRemoteQrCodeDisplay
                  value={lanWsUrl}
                  unresolved={isMobileRemoteLanHostPlaceholder(wsHost)}
                  ariaLabel={t("mobileRemote.qrAriaLabel")}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm break-all text-text-1">
                    {lanWsUrl}
                  </p>
                  <Button
                    variant="tertiary"
                    appearance="ghost"
                    size="small"
                    disabled={lanIpLoading}
                    onClick={refreshLanIp}
                  >
                    {t("mobileRemote.refreshLanIp")}
                  </Button>
                </div>
              </div>
            </SectionRow>
          ) : null}
        </>
      ) : null}
    </SectionContainer>
  );
};

export default MobileRemoteSettingsSection;
