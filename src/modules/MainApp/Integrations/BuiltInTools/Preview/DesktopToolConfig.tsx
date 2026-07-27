/**
 * ComputerUseConfig — browser CLI provider and desktop automation permissions panel.
 *
 * Returns a fragment of `SectionContainer`s (no outer wrapper) so the
 * parent page can space them with `flex flex-col gap-3`, matching
 * `ConfigGeneralSection`.
 *
 * The two known permission rows (Screen Recording, Accessibility) render
 * immediately; the status badge shows a loading indicator until the
 * runtime check completes.
 *
 * Permissions are checked natively (no external CLI required) — only the
 * parts the user can act on (granting OS permissions) are shown.
 */
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useAtomValue, useSetAtom } from "jotai";
import { Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DESKTOP_PERMISSION,
  type DesktopPermissionName,
  checkDesktopPermissions,
  requestDesktopPermissions,
} from "@src/api/tauri/agent";
import type { DesktopPermission } from "@src/api/tauri/agent";
import {
  OPTIONAL_SIDECAR,
  type OptionalSidecar,
  type SidecarStatus,
  installSidecar,
  listSidecarStatus,
} from "@src/api/tauri/sidecars";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { buildAgentOrgsPath } from "@src/config/mainAppPaths";
import {
  AGENT_BROWSER_PROVIDER,
  AGENT_BROWSER_SETTING_KEYS,
  type AgentBrowserProviderSetting,
} from "@src/config/settingsSchema/registry/agentBrowser";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { useRefreshSpin } from "@src/hooks/ui";
import { NAV_BUTTON_PROPS } from "@src/modules/MainApp/Settings/config";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  settingsAtom,
  updateSettingAtom,
} from "@src/store/settings/settingsAtom";

interface KnownPermission {
  name: DesktopPermissionName;
  descriptionKey: string;
  deepLink: string;
}

const KNOWN_PERMISSIONS: KnownPermission[] = [
  {
    name: DESKTOP_PERMISSION.SCREEN_RECORDING,
    descriptionKey: "osAgent.desktopScreenRecordingDesc",
    deepLink:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
  {
    name: DESKTOP_PERMISSION.ACCESSIBILITY,
    descriptionKey: "osAgent.desktopAccessibilityDesc",
    deepLink:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
];

interface SidecarDownloadRow {
  sidecar: OptionalSidecar;
  labelKey: string;
  descriptionKey: string;
}

const SIDECAR_DOWNLOAD_ROWS: SidecarDownloadRow[] = [
  {
    sidecar: OPTIONAL_SIDECAR.AGENT_BROWSER,
    labelKey: "builtInTools.sidecarAgentBrowserLabel",
    descriptionKey: "builtInTools.sidecarAgentBrowserDesc",
  },
  {
    sidecar: OPTIONAL_SIDECAR.PEEKABOO,
    labelKey: "builtInTools.sidecarPeekabooLabel",
    descriptionKey: "builtInTools.sidecarPeekabooDesc",
  },
];

const AgentBrowserProviderConfig: React.FC = () => {
  const { t } = useTranslation("integrations");
  const settings = useAtomValue(settingsAtom);
  const updateSetting = useSetAtom(updateSettingAtom);
  const provider =
    (settings[AGENT_BROWSER_SETTING_KEYS.PROVIDER] as
      | AgentBrowserProviderSetting
      | undefined) ?? AGENT_BROWSER_PROVIDER.AGENT_BROWSER;
  const agentBrowserCliPath =
    (settings[AGENT_BROWSER_SETTING_KEYS.AGENT_BROWSER_CLI_PATH] as
      | string
      | undefined) ?? "";
  const playwrightCliPath =
    (settings[AGENT_BROWSER_SETTING_KEYS.PLAYWRIGHT_CLI_PATH] as
      | string
      | undefined) ?? "";

  const options = [
    {
      value: AGENT_BROWSER_PROVIDER.AGENT_BROWSER,
      label: t("builtInTools.agentBrowserProviderOption.agent_browser"),
    },
    {
      value: AGENT_BROWSER_PROVIDER.PLAYWRIGHT,
      label: t("builtInTools.agentBrowserProviderOption.playwright"),
    },
  ];

  return (
    <SectionContainer>
      <SectionRow
        label={t("builtInTools.agentBrowserProvider")}
        description={t("builtInTools.agentBrowserProviderDesc")}
      >
        <Select
          value={provider}
          onChange={(value) => {
            if (typeof value !== "string") return;
            if (value === provider) return;

            void (async () => {
              await updateSetting({
                key: AGENT_BROWSER_SETTING_KEYS.PROVIDER,
                value,
              });

              const confirmed = await ask(
                t("builtInTools.agentBrowserRestartPromptMessage"),
                {
                  title: t("builtInTools.agentBrowserRestartPromptTitle"),
                  kind: "info",
                  okLabel: t("common:actions.restart"),
                  cancelLabel: t("common:actions.cancel"),
                }
              );
              if (!confirmed) return;
              await relaunch();
            })();
          }}
          options={options}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      {provider === AGENT_BROWSER_PROVIDER.AGENT_BROWSER && (
        <SectionRow
          label={t("builtInTools.agentBrowserCliPath")}
          description={t("builtInTools.agentBrowserCliPathDesc")}
        >
          <Input
            value={agentBrowserCliPath}
            onChange={(value) =>
              updateSetting({
                key: AGENT_BROWSER_SETTING_KEYS.AGENT_BROWSER_CLI_PATH,
                value,
              })
            }
            placeholder={t("builtInTools.agentBrowserCliPathPlaceholder")}
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
      )}

      {provider === AGENT_BROWSER_PROVIDER.PLAYWRIGHT && (
        <SectionRow
          label={t("builtInTools.playwrightCliPath")}
          description={t("builtInTools.playwrightCliPathDesc")}
        >
          <Input
            value={playwrightCliPath}
            onChange={(value) =>
              updateSetting({
                key: AGENT_BROWSER_SETTING_KEYS.PLAYWRIGHT_CLI_PATH,
                value,
              })
            }
            placeholder={t("builtInTools.playwrightCliPathPlaceholder")}
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
      )}
    </SectionContainer>
  );
};

const SidecarDownloadsConfig: React.FC = () => {
  const { t } = useTranslation("integrations");
  const [statuses, setStatuses] = useState<SidecarStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<OptionalSidecar | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatuses = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listSidecarStatus();
      setStatuses(result);
      setError(null);
    } catch (err) {
      setStatuses(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSidecarStatus()
      .then((result) => {
        if (cancelled) return;
        setStatuses(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatuses(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleInstall = useCallback(async (sidecar: OptionalSidecar) => {
    setInstalling(sidecar);
    try {
      const installed = await installSidecar(sidecar);
      setStatuses((current) => {
        const next = current ?? [];
        const existingIndex = next.findIndex(
          (entry) => entry.sidecar === sidecar
        );
        if (existingIndex === -1) {
          return [...next, installed];
        }
        return next.map((entry) =>
          entry.sidecar === sidecar ? installed : entry
        );
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(null);
    }
  }, []);

  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    refreshStatuses,
    loading
  );

  const statusMap = useMemo(() => {
    if (!statuses) return new Map<OptionalSidecar, SidecarStatus>();
    return new Map(statuses.map((status) => [status.sidecar, status]));
  }, [statuses]);

  return (
    <SectionContainer title={t("builtInTools.sidecarDownloadsSectionTitle")}>
      {SIDECAR_DOWNLOAD_ROWS.map((row) => {
        const status = statusMap.get(row.sidecar);
        const isInstalling = installing === row.sidecar;
        const unsupported = status?.supported === false;
        const installed = status?.installed === true;

        let statusContent: React.ReactNode;
        if (loading && !status) {
          statusContent = (
            <Loader2 size={14} className="animate-spin text-text-3" />
          );
        } else if (unsupported) {
          statusContent = (
            <span className="whitespace-nowrap text-xs text-text-3">
              {t("builtInTools.sidecarUnsupported")}
            </span>
          );
        } else if (installed) {
          statusContent = (
            <span className="whitespace-nowrap text-xs text-success-6">
              {t("builtInTools.sidecarInstalled")}
            </span>
          );
        } else {
          statusContent = (
            <span className="whitespace-nowrap text-xs text-warning-6">
              {t("builtInTools.sidecarNotInstalled")}
            </span>
          );
        }

        return (
          <SectionRow
            key={row.sidecar}
            label={t(row.labelKey)}
            description={t(row.descriptionKey)}
          >
            <div className="flex items-center gap-2">
              {statusContent}
              <Button
                size="default"
                icon={
                  isInstalling ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )
                }
                disabled={loading || unsupported || installed || isInstalling}
                onClick={() => handleInstall(row.sidecar)}
              >
                {installed
                  ? t("builtInTools.sidecarInstalledAction")
                  : t("builtInTools.sidecarDownloadAction")}
              </Button>
            </div>
          </SectionRow>
        );
      })}

      <SectionRow
        label={t("builtInTools.sidecarRefreshStatus")}
        description={t("builtInTools.sidecarRefreshStatusDesc")}
      >
        <Button
          size="default"
          icon={<RefreshCw size={14} className={spinClass} />}
          onClick={handleRefreshClick}
          disabled={installing !== null}
        >
          {t("builtInTools.sidecarRefreshStatus")}
        </Button>
      </SectionRow>

      {error && (
        <SectionRow
          label={t("builtInTools.sidecarLastError")}
          description={error}
        />
      )}
    </SectionContainer>
  );
};

const ComputerUseConfig: React.FC = () => {
  const { t } = useTranslation("settings");
  const { t: tIntegrations } = useTranslation("integrations");
  const { navigateTo } = useAppNavigation();
  const [permissions, setPermissions] = useState<DesktopPermission[] | null>(
    null
  );
  const [checkingPerms, setCheckingPerms] = useState(false);
  const [grantingPerm, setGrantingPerm] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const isMac =
    typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

  const goToWingmanSafety = useCallback(() => {
    navigateTo(buildAgentOrgsPath({ tab: "agents" }));
  }, [navigateTo]);

  const fetchPermissions = useCallback(async () => {
    setCheckingPerms(true);
    try {
      const result = await checkDesktopPermissions();
      setPermissions(result);
      setFetchError(null);
    } catch (err) {
      setPermissions(null);
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingPerms(false);
    }
  }, []);

  const handleConfigure = useCallback(async (perm: KnownPermission) => {
    setGrantingPerm(perm.name);
    try {
      const result = await requestDesktopPermissions(perm.name);
      setPermissions(result.permissions);
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setGrantingPerm(null);
    }
    await shellOpen(perm.deepLink);
  }, []);

  useEffect(() => {
    if (!isMac) return;
    let cancelled = false;
    checkDesktopPermissions()
      .then((result) => {
        if (cancelled) return;
        setPermissions(result);
        setFetchError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPermissions(null);
        setFetchError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [isMac]);

  const { spinClass: permsSpinClass, handleClick: handlePermsClick } =
    useRefreshSpin(fetchPermissions, checkingPerms);

  const permMap = useMemo(() => {
    if (!permissions) return null;
    const map = new Map<string, boolean>();
    for (const perm of permissions) {
      map.set(perm.name, perm.granted);
    }
    return map;
  }, [permissions]);

  const isLoading = permissions === null && fetchError === null;

  if (!isMac) {
    return (
      <div className={SECTION_GAP_CLASSES}>
        <AgentBrowserProviderConfig />
        <SidecarDownloadsConfig />
        <SectionContainer
          title={tIntegrations(
            "builtInTools.computerUsePermissionsSectionTitle"
          )}
        >
          <Placeholder
            variant="empty"
            placement="sidebar"
            title={t("osAgent.desktopUnsupportedPlatformTitle")}
            subtitle={t("osAgent.desktopUnsupportedPlatformDesc")}
          />
        </SectionContainer>
      </div>
    );
  }

  return (
    <div className={SECTION_GAP_CLASSES}>
      <AgentBrowserProviderConfig />
      <SidecarDownloadsConfig />
      <SectionContainer
        title={tIntegrations("builtInTools.computerUsePermissionsSectionTitle")}
      >
        {KNOWN_PERMISSIONS.map((perm) => {
          const granted = permMap?.get(perm.name) ?? null;

          let statusContent: React.ReactNode;
          if (isLoading) {
            statusContent = (
              <Loader2 size={14} className="animate-spin text-text-3" />
            );
          } else if (fetchError !== null) {
            statusContent = (
              <span className="whitespace-nowrap text-xs text-danger-6">
                {t("osAgent.desktopPermissionsUnavailable", "Unavailable")}
              </span>
            );
          } else if (granted === true) {
            statusContent = (
              <span className="whitespace-nowrap text-xs text-success-6">
                {t("osAgent.desktopPermissionGranted")}
              </span>
            );
          } else {
            statusContent = (
              <span className="whitespace-nowrap text-xs text-warning-6">
                {t("osAgent.desktopPermissionNotGranted")}
              </span>
            );
          }

          return (
            <SectionRow
              key={perm.name}
              label={perm.name}
              description={t(perm.descriptionKey)}
            >
              <div className="flex items-center gap-2">
                {statusContent}
                <Button
                  {...NAV_BUTTON_PROPS}
                  onClick={() => handleConfigure(perm)}
                  disabled={isLoading || grantingPerm === perm.name}
                >
                  {t("common:actions.configure")}
                </Button>
              </div>
            </SectionRow>
          );
        })}

        <SectionRow
          label={t("osAgent.desktopRecheckPermissions")}
          description={t(
            "osAgent.desktopRecheckPermissionsDesc",
            "Re-query the OS if you just toggled a permission in System Settings"
          )}
        >
          <Button
            size="default"
            icon={<RefreshCw size={14} className={permsSpinClass} />}
            onClick={handlePermsClick}
          >
            {t("osAgent.desktopRecheckPermissions")}
          </Button>
        </SectionRow>

        <SectionRow
          label={t("osAgent.desktopSafetyDeepLinkLabel")}
          description={t("osAgent.desktopSafetyDeepLinkDesc")}
        >
          <Button
            size="default"
            icon={<ExternalLink size={14} />}
            onClick={goToWingmanSafety}
          >
            {t("osAgent.desktopSafetyDeepLinkAction")}
          </Button>
        </SectionRow>
      </SectionContainer>
    </div>
  );
};

export default ComputerUseConfig;
