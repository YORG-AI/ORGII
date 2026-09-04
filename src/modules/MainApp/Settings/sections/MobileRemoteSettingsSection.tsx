import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  PERMISSION_TIER,
  type PairedDeviceInfo,
  type PairingInitOutput,
  type RelayStatus,
  mobileRemoteApi,
} from "@src/api/tauri/mobileRemote";
import Button from "@src/components/Button";
import { InlineBanner } from "@src/components/InlineBanner";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import Switch from "@src/components/Switch";
import { buildSettingsPath } from "@src/config/mainAppPaths";
import {
  type MobileRemoteRelayPreset,
  mobileRemoteRelayPresetUrl,
  resolveMobileRemoteRelayPreset,
} from "@src/config/mobileRemoteRelay";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { useAsyncData } from "@src/hooks/async";
import { useSetting } from "@src/hooks/settings/useSettings";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { SECTION_IDS } from "../config";
import MobileRemoteOutdoorPairingDetails from "./MobileRemoteOutdoorPairingDetails";
import MobileRemoteQrCodeDisplay from "./MobileRemoteQrCodeDisplay";
import PairedDeviceList from "./PairedDeviceList";
import {
  buildMobileRemoteWsUrl,
  fetchMobileRemoteLanIp,
  formatMobileRemoteRelayStatusMessage,
  generateMobileRemoteLanToken,
  isMobileRemoteLanHostPlaceholder,
  isMobileRemoteRelayReady,
  resolveMobileRemoteLanHostWithIp,
  usesLocalRelayDesktopToken,
} from "./mobileRemoteSettingsHelpers";
import { suggestOutdoorPairingPhoneLabel } from "./pairedDeviceDisplay";

function formatDeviceTimestamp(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  return formatRelativeTime(ms, "short");
}

const MobileRemoteSettingsSection: React.FC = () => {
  const { t } = useTranslation(["settings", "navigation", "common"]);
  const navigate = useNavigate();
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const handleCloudSignIn = useOrg2CloudSignIn();
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

  const [phoneLabel, setPhoneLabel] = useState(() =>
    suggestOutdoorPairingPhoneLabel()
  );
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

  const activeRelayPreset = useMemo(
    () => resolveMobileRemoteRelayPreset(relayUrl),
    [relayUrl]
  );
  const usesLocalDesktopToken = usesLocalRelayDesktopToken(relayUrl);
  const cloudSignedIn = cloudAuth != null;
  const cloudSignedInIdentity =
    cloudAuth?.profile?.displayName ??
    cloudAuth?.profile?.primaryEmail ??
    cloudAuth?.userId ??
    "";

  const relayConfigured = isMobileRemoteRelayReady({
    relayUrl,
    desktopToken,
    cloudSignedIn,
  });
  const relayQueryKey = `${enabled}:${relayEnabled}:${relayUrl}:${usesLocalDesktopToken ? desktopToken.length : (cloudAuth?.userId ?? "signed-out")}`;
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
        label: phoneLabel.trim() || suggestOutdoorPairingPhoneLabel(),
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

  const handleRelayPresetChange = useCallback(
    (preset: MobileRemoteRelayPreset) => {
      setRelayUrl(mobileRemoteRelayPresetUrl(preset));
    },
    [setRelayUrl]
  );

  const handleOpenGeneralSettings = useCallback(() => {
    navigate(buildSettingsPath({ section: SECTION_IDS.GENERAL }));
  }, [navigate]);

  const relayStatusDescription = useMemo(() => {
    const formatted = formatMobileRemoteRelayStatusMessage(
      relayStatus?.message,
      relayUrl,
      cloudSignedIn,
      t
    );
    if (formatted) {
      return formatted;
    }
    if (!usesLocalDesktopToken && !cloudSignedIn) {
      return t("mobileRemote.cloudLoginDescSignedOut");
    }
    return t("mobileRemote.relayEnabledDesc");
  }, [cloudSignedIn, relayStatus?.message, relayUrl, t, usesLocalDesktopToken]);

  useEffect(() => {
    pairingRequestIdRef.current += 1;
    setPairing(null);
    setPairingLoading(false);
  }, [
    cloudAuth?.userId,
    enabled,
    relayEnabled,
    relayUrl,
    usesLocalDesktopToken,
  ]);

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
            {usesLocalDesktopToken
              ? t("mobileRemote.relaySetupNoticeLocal")
              : t("mobileRemote.relaySetupNotice")}
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
                <div className="flex w-full flex-col items-start gap-2">
                  <SegmentedTextPill
                    ariaLabel={t("mobileRemote.relayPresetAria")}
                    dataTestId="mobile-remote-relay-preset"
                    size="small"
                    value={activeRelayPreset}
                    options={[
                      {
                        value: "local",
                        label: t("mobileRemote.relayPresetLocal"),
                      },
                      {
                        value: "production",
                        label: t("mobileRemote.relayPresetProduction"),
                      },
                    ]}
                    onChange={handleRelayPresetChange}
                  />
                  <Input
                    value={relayUrl}
                    onChange={setRelayUrl}
                    placeholder="wss://relay.example.com/v1/mobile/ws"
                    spellCheck={false}
                  />
                </div>
              </SectionRow>

              {usesLocalDesktopToken ? (
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
              ) : (
                <SectionRow
                  label={t("mobileRemote.cloudLoginTitle")}
                  description={
                    cloudSignedIn
                      ? t("mobileRemote.cloudLoginDescSignedIn", {
                          identity: cloudSignedInIdentity,
                        })
                      : t("mobileRemote.cloudLoginDescSignedOut")
                  }
                  indent
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {cloudSignedIn ? (
                      <span className="text-sm text-text-2">
                        {cloudSignedInIdentity}
                      </span>
                    ) : (
                      <Button
                        size="default"
                        onClick={handleCloudSignIn}
                        data-testid="mobile-remote-cloud-sign-in"
                      >
                        {t("navigation:cloud.signIn")}
                      </Button>
                    )}
                    <Button
                      variant="tertiary"
                      appearance="ghost"
                      size="small"
                      onClick={handleOpenGeneralSettings}
                      data-testid="mobile-remote-open-general-settings"
                    >
                      {t("mobileRemote.openGeneralSettings")}
                    </Button>
                  </div>
                </SectionRow>
              )}

              <SectionRow
                label={t("mobileRemote.relayStatus")}
                description={relayStatusDescription}
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
                  <PairedDeviceList
                    devices={devices}
                    formatTimestamp={formatDeviceTimestamp}
                    onRevoke={(deviceId) => void handleRevokeDevice(deviceId)}
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
